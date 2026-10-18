package datamgr

import (
	"archive/zip"
	"compress/flate"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"time"

	"live/api/internal/config"
)

// ============================================================================
// 备份服务 —— from: service/backup.js + service/exportTask.js 中的 mysqldump 部分
// archiver(zip) → archive/zip；mysqldump npm → os/exec 外调系统 mysqldump。
// ENV-001：mysqldump 二进制缺失时返回明确错误（接口 500），与 Node 同败因。
// ============================================================================

// dbConfig 对应 getDbConfig()。
type dbConfig struct {
	Host     string
	Port     int
	User     string
	Password string
	Database string
}

func getDbConfig() dbConfig {
	return dbConfig{
		Host:     config.Get("DB_HOST", "localhost"),
		Port:     envInt("DB_PORT", 3306),
		User:     config.Get("DB_USER", "root"),
		Password: config.Get("DB_PASSWORD", ""),
		Database: config.Get("DB_NAME", "live"),
	}
}

func envInt(k string, def int) int {
	if v := config.Get(k, ""); v != "" {
		var n int
		if _, err := fmt.Sscanf(v, "%d", &n); err == nil {
			return n
		}
	}
	return def
}

// mysqldumpBin 探测并返回 mysqldump 路径（ENV-001）。
func mysqldumpBin() (string, error) {
	p, err := exec.LookPath("mysqldump")
	if err != nil {
		return "", errors.New("mysqldump 二进制不可用（系统未安装 mysql-client，ENV-001）")
	}
	return p, nil
}

// buildDumpArgs 构造 mysqldump CLI 参数。
//
// 🔒 SYNC-A13（2026-10-12）修正阻断级缺陷：
//
//	原实现固定拼 `--databases <db>` 再把表名当位置参数追加，
//	而 CLI 语义下 `--databases` 之后的**所有位置参数都被当库名**，
//	于是 `todo`/`account` 被当成数据库 ⇒ 单表备份必然失败，
//	进而 `POST /data-manager/import`（前置 backupSingleTable）必然 500。
//	现改为：单表走 `<db> --tables <t>`（CLI 合法用法）。
//
// ⚠ **SYNC-A41（2026-10-13）订正上一条注释里的错误技术论断**：
//
//	原文写「与 Node 的 mysqldump npm 包语义对齐」——**这是错的**。
//	经核证 `api/node_modules/mysqldump/dist/cjs.js`：该包是**纯 JS 实现**，
//	内部用 mysql2 跑 `SHOW FULL TABLES` / `SHOW CREATE TABLE` / `SELECT *` 自拼 SQL，
//	全文件 **0 处** child_process / spawn / exec，"mysqldump" 字样都不出现。
//	即它根本不接受 CLI 参数，谈不上"参数逐字对齐"。
//
//	准确表述：Go 端**换了一种 dumper**（外部 CLI 二进制 vs 进程内 JS），
//	参数是合法的 CLI 用法，但**产物 SQL 文本结构与 Node 不完全一致**：
//	  · 全库备份：CLI 会额外产出 `CREATE DATABASE /*!32312 IF NOT EXISTS*/` + `USE`，npm 包不产出
//	  · 密码传递：CLI 的 `--password=<明文>` 会出现在 `ps` 进程列表（npm 包走配置对象，不进进程表）
//	  · 输出文件：CLI 用 O_TRUNC（Go os.Create），npm 包用 O_APPEND
//	  · 依赖：Go 侧需系统安装 mysql-client，缺失即整模块 500（ENV-001）
//
//	**待实测**（本机无 mysqldump，无法验证）：
//	  1. mysqldump 是否存在、版本是否与 MySQL 服务端匹配
//	  2. MySQL 8 客户端 + 5.7 服务端下 --column-statistics 是否报
//	     `Unknown table 'COLUMNS_STATISTICS'`（Node 路径无此风险，Go 有）
//	  3. 单表 --tables 路径真正跑通一次（本次改动唯一要验的行为）
//	  4. 备份产物能否被 POST /import/sql 回灌（自洽性闭环）
func buildDumpArgs(tableName string, includeData bool) []string {
	c := getDbConfig()
	args := []string{
		"--host=" + c.Host,
		"--port=" + fmt.Sprintf("%d", c.Port),
		"--user=" + c.User,
		"--password=" + c.Password,
	}
	// 全库备份：Node 包在 dump.tables 为空时对整库 dump（等价 --all-databases 之外的默认库）
	if tableName == "" {
		args = append(args, "--databases", c.Database)
	} else {
		args = append(args, c.Database, "--tables", tableName)
	}
	// dump: { schema: { table: { dropIfExists: true } }, data: includeData ? {} : false, trigger: false }
	if !includeData {
		args = append(args, "--no-data")
	}
	args = append(args, "--skip-triggers")
	return args
}

// runMysqldump 外调 mysqldump 并将 stdout 写入 dumpToFile（对应 dumpToFile 选项）。
func runMysqldump(dumpToFile string, tableName string, includeData bool) error {
	bin, err := mysqldumpBin()
	if err != nil {
		return err
	}
	f, err := os.Create(dumpToFile)
	if err != nil {
		return err
	}
	defer f.Close()
	cmd := exec.Command(bin, buildDumpArgs(tableName, includeData)...)
	cmd.Stdout = f
	var stderr strings.Builder
	cmd.Stderr = &stderr
	if err := cmd.Run(); err != nil {
		_ = os.Remove(dumpToFile) // 对应 Node catch 中的 unlink
		if stderr.Len() > 0 {
			return fmt.Errorf("mysqldump 执行失败: %s", strings.TrimSpace(stderr.String()))
		}
		return fmt.Errorf("mysqldump 执行失败: %v", err)
	}
	return nil
}

// getBackupDir data/sql/table（对应 BackupService.getBackupDir / ExportTaskManager.getBackupDir）。
func getBackupDir() string {
	dir := config.PathUnder(filepath.Join("data", "sql", "table"))
	_ = os.MkdirAll(dir, 0o755)
	return dir
}

// getSystemBackupDir data/sql/backup。
func getSystemBackupDir() string { return config.PathUnder(filepath.Join("data", "sql", "backup")) }

// getDateBackupDir data/sql/backup/{dateStr}。
func getDateBackupDir(dateStr string) string {
	dir := filepath.Join(getSystemBackupDir(), dateStr)
	_ = os.MkdirAll(dir, 0o755)
	return dir
}

// stampNow 对应 dayjs().format('YYYYMMDD-HHmmss')。
func stampNow() string { return time.Now().Format("20060102-150405") }

// zipSingleFile 将单个文件打包为 zip（对应 archiver(ZipArchive{level:6/9}).file）。
func zipSingleFile(srcPath, nameInZip, zipPath string, level int) (int64, error) {
	out, err := os.Create(zipPath)
	if err != nil {
		return 0, err
	}
	defer out.Close()
	zw := zip.NewWriter(out)
	if level < 0 || level > 9 {
		level = 6
	}
	zw.RegisterCompressor(zip.Deflate, func(w io.Writer) (io.WriteCloser, error) {
		return flate.NewWriter(w, level)
	})
	hdr := &zip.FileHeader{Name: nameInZip, Method: zip.Deflate}
	hdr.SetMode(0o644)
	fw, err := zw.CreateHeader(hdr)
	if err != nil {
		_ = zw.Close()
		return 0, err
	}
	in, err := os.Open(srcPath)
	if err != nil {
		_ = zw.Close()
		return 0, err
	}
	if _, err := io.Copy(fw, in); err != nil {
		in.Close()
		_ = zw.Close()
		return 0, err
	}
	in.Close()
	if err := zw.Close(); err != nil {
		return 0, err
	}
	st, err := os.Stat(zipPath)
	if err != nil {
		return 0, err
	}
	return st.Size(), nil
}

// backupSingleTable 对应 backupSingleTable(tableName, includeData=true)。
func backupSingleTable(tableName string, includeData bool) (filename, filepathOut string, size int64, err error) {
	timestamp := stampNow()
	filename = timestamp + "-" + tableName + ".sql"
	filepathOut = filepath.Join(getBackupDir(), filename)

	if err := runMysqldump(filepathOut, tableName, includeData); err != nil {
		if fileExists(filepathOut) {
			_ = os.Remove(filepathOut)
		}
		return "", "", 0, err
	}
	st, err := os.Stat(filepathOut)
	if err != nil {
		return "", "", 0, err
	}
	return filename, filepathOut, st.Size(), nil
}

// backupAllTablesToZip 对应 backupAllTablesToZip(includeData=true)：全库 SQL → zip。
func backupAllTablesToZip(includeData bool) (sqlFilename, zipFilename, zipFilepath string, zipSize int64, err error) {
	timestamp := stampNow()
	sqlFilename = timestamp + "-full-backup.sql"
	sqlFilepath := filepath.Join(getBackupDir(), sqlFilename)
	zipFilename = timestamp + "-full-backup.sql.zip"
	zipFilepath = filepath.Join(getBackupDir(), zipFilename)

	if err := runMysqldump(sqlFilepath, "", includeData); err != nil {
		if fileExists(sqlFilepath) {
			_ = os.Remove(sqlFilepath)
		}
		return "", "", "", 0, err
	}

	zipSize, err = zipSingleFile(sqlFilepath, sqlFilename, zipFilepath, 9)
	if err != nil {
		if fileExists(sqlFilepath) {
			_ = os.Remove(sqlFilepath)
		}
		return "", "", "", 0, err
	}
	if fileExists(sqlFilepath) {
		_ = os.Remove(sqlFilepath)
	}
	return sqlFilename, zipFilename, zipFilepath, zipSize, nil
}

// backupFileInfo 对应 listBackups 的返回项。
type backupFileInfo struct {
	Filename  string
	Filepath  string
	Size      int64
	CreatedAt time.Time
	Type      string // zip / sql
}

func (b backupFileInfo) toMap() map[string]any {
	return map[string]any{
		"filename":  b.Filename,
		"filepath":  b.Filepath,
		"size":      b.Size,
		"createdAt": b.CreatedAt.UTC().Format("2006-01-02T15:04:05.000Z"),
		"type":      b.Type,
	}
}

// listBackups 对应 listBackups()（按创建时间倒序）。
// 注：Node 用 stats.birthtime；Go stdlib 无便携 birthtime，此处用 ModTime（差异记录）。
func listBackups() ([]map[string]any, error) {
	backupDir := getBackupDir()
	entries, err := os.ReadDir(backupDir)
	if err != nil {
		return nil, err
	}
	var infos []backupFileInfo
	for _, e := range entries {
		if e.IsDir() {
			continue
		}
		name := e.Name()
		if !strings.HasSuffix(name, ".sql") && !strings.HasSuffix(name, ".zip") {
			continue
		}
		info, err := e.Info()
		if err != nil {
			continue
		}
		infos = append(infos, backupFileInfo{
			Filename:  name,
			Filepath:  filepath.Join(backupDir, name),
			Size:      info.Size(),
			CreatedAt: info.ModTime(),
			Type:      map[bool]string{true: "zip", false: "sql"}[strings.HasSuffix(name, ".zip")],
		})
	}
	sort.Slice(infos, func(i, j int) bool { return infos[i].CreatedAt.After(infos[j].CreatedAt) })
	out := make([]map[string]any, 0, len(infos))
	for _, i := range infos {
		out = append(out, i.toMap())
	}
	return out, nil
}

// deleteBackup 对应 deleteBackup(filename)（路径穿越防护 + 不存在报错）。
func deleteBackup(filename string) error {
	backupDir := getBackupDir()
	filepathOut := filepath.Join(backupDir, filename)
	resolvedPath, err := filepath.Abs(filepathOut)
	if err != nil {
		return errors.New("文件名不合法")
	}
	resolvedBase, err := filepath.Abs(backupDir)
	if err != nil {
		return errors.New("文件名不合法")
	}
	if !strings.HasPrefix(resolvedPath, resolvedBase+string(filepath.Separator)) && resolvedPath != resolvedBase {
		return errors.New("文件名不合法")
	}
	if !fileExists(filepathOut) {
		return errors.New("备份文件不存在")
	}
	return os.Remove(filepathOut)
}

// listSystemBackups 对应 listSystemBackups()：按日期目录分组。
func listSystemBackups() ([]map[string]any, error) {
	baseDir := getSystemBackupDir()
	dateDirs, err := os.ReadDir(baseDir)
	if err != nil {
		return []map[string]any{}, nil // Node: !existsSync → []
	}
	type dateEntry struct {
		name  string
		files []map[string]any
	}
	var dates []dateEntry
	for _, de := range dateDirs {
		if !de.IsDir() {
			continue
		}
		if !dateDirRe.MatchString(de.Name()) {
			continue
		}
		dateStr := de.Name()
		dirPath := filepath.Join(baseDir, dateStr)
		files, err := os.ReadDir(dirPath)
		if err != nil {
			continue
		}
		var fileInfos []map[string]any
		for _, fe := range files {
			name := fe.Name()
			if !strings.HasSuffix(name, ".sql") || fe.IsDir() {
				continue
			}
			info, err := fe.Info()
			if err != nil {
				continue
			}
			isSchemaOnly := strings.Contains(name, "schema-only")
			fileInfos = append(fileInfos, map[string]any{
				"filename":  name,
				"filepath":  filepath.Join(dirPath, name),
				"size":      info.Size(),
				"createdAt": info.ModTime().UTC().Format("2006-01-02T15:04:05.000Z"),
				"type":      map[bool]string{true: "schema-only", false: "full"}[isSchemaOnly],
			})
		}
		sort.Slice(fileInfos, func(i, j int) bool {
			return toStr(fileInfos[i]["createdAt"]) > toStr(fileInfos[j]["createdAt"])
		})
		if len(fileInfos) > 0 {
			dates = append(dates, dateEntry{name: dateStr, files: fileInfos})
		}
	}
	sort.Slice(dates, func(i, j int) bool { return dates[i].name > dates[j].name })
	result := make([]map[string]any, 0, len(dates))
	for _, d := range dates {
		result = append(result, map[string]any{"date": d.name, "files": d.files})
	}
	return result, nil
}

// dateDirRe 对应 /^\d{4}-\d{2}-\d{2}$/。
var dateDirRe = regexp.MustCompile(`^\d{4}-\d{2}-\d{2}$`)

// unzipFindSQL 对应 importSql 的 zip 解包：找第一个 .sql 条目并返回内容。
func unzipFindSQL(zipPath string) (string, error) {
	r, err := zip.OpenReader(zipPath)
	if err != nil {
		return "", err
	}
	defer r.Close()
	for _, f := range r.File {
		if f.FileInfo().IsDir() {
			continue
		}
		if strings.ToLower(filepath.Ext(f.Name)) != ".sql" {
			continue
		}
		rc, err := f.Open()
		if err != nil {
			return "", err
		}
		content, err := io.ReadAll(io.LimitReader(rc, 512<<20))
		rc.Close()
		if err != nil {
			return "", err
		}
		return string(content), nil
	}
	return "", errors.New("ZIP 文件中未找到 .sql 文件")
}

// fileExists 对应 fs.existsSync。
func fileExists(p string) bool {
	_, err := os.Stat(p)
	return err == nil
}
