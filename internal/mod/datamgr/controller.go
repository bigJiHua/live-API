package datamgr

import (
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"time"

	"live/api/internal/db"
	"live/api/internal/resp"
)

// ============================================================================
// 数据管理控制器 —— from: controller/index.js
// ============================================================================

// bodyData 对应 `req.body` / `req.body.data`（dataManager 直接读 req.body）。
func bodyData(b resp.Body) map[string]any {
	if v, ok := b.Raw["data"]; ok {
		if m, ok := v.(map[string]any); ok {
			return m
		}
	}
	return b.Raw
}

// GetTableList 获取表列表。from: controller/index.js:14-23
func GetTableList(w http.ResponseWriter, r *http.Request) {
	tables, err := getTableList()
	if err != nil {
		resp.JSON(w, 200, map[string]any{"status": 500, "message": "获取表列表失败"})
		return
	}
	resp.JSON(w, 200, map[string]any{"status": 200, "data": tables})
}

// GetTableStatus 获取表状态。from: controller/index.js:25-33
func GetTableStatus(w http.ResponseWriter, r *http.Request) {
	status, err := getTableStatus()
	if err != nil {
		resp.JSON(w, 200, map[string]any{"status": 500, "message": "获取表状态失败"})
		return
	}
	resp.JSON(w, 200, map[string]any{"status": 200, "data": status})
}

// GetTableStructure 获取表结构。from: controller/index.js:35-45
func GetTableStructure(w http.ResponseWriter, r *http.Request) {
	tableName := r.PathValue("tableName")
	if tableName == "" {
		resp.JSON(w, 200, map[string]any{"status": 400, "message": "表名不能为空"})
		return
	}
	structure, err := getTableStructure(tableName)
	if err != nil {
		if isBadTable(err) {
			resp.JSON(w, 200, map[string]any{"status": 400, "message": err.Error()})
			return
		}
		resp.JSON(w, 200, map[string]any{"status": 500, "message": "获取表结构失败"})
		return
	}
	resp.JSON(w, 200, map[string]any{"status": 200, "data": structure})
}

// GetTableData 获取表数据。from: controller/index.js:47-60
func GetTableData(w http.ResponseWriter, r *http.Request) {
	tableName := r.PathValue("tableName")
	q := r.URL.Query()
	if tableName == "" {
		resp.JSON(w, 200, map[string]any{"status": 400, "message": "表名不能为空"})
		return
	}
	result, err := getTableData(tableName, jsParseInt(orDefault(q.Get("page"), "1")), jsParseInt(orDefault(q.Get("pageSize"), "100")))
	if err != nil {
		if isBadTable(err) {
			resp.JSON(w, 200, map[string]any{"status": 400, "message": err.Error()})
			return
		}
		resp.JSON(w, 200, map[string]any{"status": 500, "message": "获取表数据失败"})
		return
	}
	resp.JSON(w, 200, map[string]any{"status": 200, "data": result})
}

// ExportSingleTable 单表导出（异步任务）。from: controller/index.js:64-93
func ExportSingleTable(w http.ResponseWriter, r *http.Request) {
	tableName := r.PathValue("tableName")
	if tableName == "" {
		resp.JSON(w, 200, map[string]any{"status": 400, "message": "表名不能为空"})
		return
	}
	includeData := orDefault(r.URL.Query().Get("includeData"), "true") == "true"

	// 并发保护：检查是否已有同类型任务在执行
	if running := getRunningTask("export_table"); running != nil {
		resp.JSON(w, 200, map[string]any{
			"status": 202, "message": "已有表导出任务正在执行中",
			"data": map[string]any{"taskId": running.ID, "status": running.Status, "reuseExisting": true},
		})
		return
	}

	task, err := createExportTask(tableName, map[string]any{"includeData": includeData})
	if err != nil {
		if isBadTable(err) {
			resp.JSON(w, 200, map[string]any{"status": 400, "message": err.Error()})
			return
		}
		resp.JSON(w, 200, map[string]any{"status": 500, "message": "导出表失败"})
		return
	}
	resp.JSON(w, 200, map[string]any{
		"status": 202, "message": "表导出任务已提交，正在后台执行",
		"data": map[string]any{"taskId": task.ID, "status": task.Status},
	})
}

// ExportFullDatabase 全库导出（异步任务）。from: controller/index.js:95-122
func ExportFullDatabase(w http.ResponseWriter, r *http.Request) {
	includeData := orDefault(r.URL.Query().Get("includeData"), "true") == "true"

	// 并发保护
	if running := getRunningTask("export_full_database"); running != nil {
		resp.JSON(w, 200, map[string]any{
			"status": 202, "message": "已有全库导出任务正在执行中",
			"data": map[string]any{"taskId": running.ID, "status": running.Status, "reuseExisting": true},
		})
		return
	}

	task, err := createFullExportTask(map[string]any{"includeData": includeData})
	if err != nil {
		resp.JSON(w, 200, map[string]any{"status": 500, "message": "备份数据库失败"})
		return
	}
	resp.JSON(w, 200, map[string]any{
		"status": 202, "message": "全库导出任务已提交，正在后台执行",
		"data": map[string]any{"taskId": task.ID, "status": task.Status},
	})
}

// ValidateImportData 校验导入数据。from: controller/index.js:126-152
func ValidateImportData(w http.ResponseWriter, r *http.Request) {
	d := bodyData(resp.Parse(r))
	tableName := toStr(d["tableName"])
	if tableName == "" {
		resp.JSON(w, 200, map[string]any{"status": 400, "message": "表名不能为空"})
		return
	}
	data, ok := d["data"].([]any)
	if !ok || len(data) == 0 {
		resp.JSON(w, 200, map[string]any{"status": 400, "message": "数据必须是包含对象的非空数组"})
		return
	}
	tableColumns, err := getColumnNames(tableName)
	if err != nil {
		resp.JSON(w, 200, map[string]any{"status": 500, "message": "校验数据失败"})
		return
	}
	colSet := map[string]bool{}
	for _, c := range tableColumns {
		colSet[c] = true
	}
	validationResult := map[string]any{
		"tableName":    tableName,
		"tableColumns": tableColumns,
		"totalRows":    len(data),
		"validRows":    0,
		"invalidRows":  0,
		"errors":       []map[string]any{},
	}
	validRows, invalidRows := 0, 0
	var errs []map[string]any
	for i, item := range data {
		row, _ := item.(map[string]any)
		var rowErrors []string
		for _, col := range tableColumns {
			if _, exists := row[col]; !exists && col != "id" && col != "create_time" && col != "update_time" {
				rowErrors = append(rowErrors, "缺少字段: "+col)
			}
		}
		var extraColumns []string
		for k := range row {
			if !colSet[k] {
				extraColumns = append(extraColumns, k)
			}
		}
		if len(extraColumns) > 0 {
			rowErrors = append(rowErrors, "多余字段将被忽略: "+strings.Join(extraColumns, ", "))
		}
		if len(rowErrors) == 0 {
			validRows++
		} else {
			invalidRows++
			errs = append(errs, map[string]any{"row": i + 1, "errors": rowErrors})
		}
	}
	validationResult["validRows"] = validRows
	validationResult["invalidRows"] = invalidRows
	validationResult["errors"] = errs
	resp.JSON(w, 200, map[string]any{
		"status": 200, "data": validationResult, "canImport": invalidRows == 0,
	})
}

// ImportData 导入数据（先自动备份）。from: controller/index.js:154-177
func ImportData(w http.ResponseWriter, r *http.Request) {
	d := bodyData(resp.Parse(r))
	tableName := toStr(d["tableName"])
	if tableName == "" {
		resp.JSON(w, 200, map[string]any{"status": 400, "message": "表名不能为空"})
		return
	}
	data, ok := d["data"].([]any)
	if !ok || len(data) == 0 {
		resp.JSON(w, 200, map[string]any{"status": 400, "message": "数据必须是包含对象的非空数组"})
		return
	}
	forceClear := false
	if v, ok := d["forceClear"].(bool); ok {
		forceClear = v
	}
	var backupFilename string
	tableColumns, err := getColumnNames(tableName)
	if err != nil {
		resp.JSON(w, 200, map[string]any{"status": 500, "message": "导入数据失败", "backupFile": nil})
		return
	}
	filename, _, _, err := backupSingleTable(tableName, true)
	if err != nil {
		resp.JSON(w, 200, map[string]any{"status": 500, "message": "导入数据失败", "backupFile": nil})
		return
	}
	backupFilename = filename

	filtered := make([]map[string]any, 0, len(data))
	for _, item := range data {
		row, _ := item.(map[string]any)
		f := map[string]any{}
		for _, col := range tableColumns {
			if v, exists := row[col]; exists {
				f[col] = v
			}
		}
		filtered = append(filtered, f)
	}
	if forceClear {
		if err := truncateTable(tableName); err != nil {
			resp.JSON(w, 200, map[string]any{"status": 500, "message": "导入数据失败", "backupFile": backupFilename})
			return
		}
	}
	affected, err := insertBatch(tableName, filtered)
	if err != nil {
		resp.JSON(w, 200, map[string]any{"status": 500, "message": "导入数据失败", "backupFile": backupFilename})
		return
	}
	resp.JSON(w, 200, map[string]any{
		"status": 200, "message": "数据导入成功",
		"data": map[string]any{"importedRows": affected, "totalRows": len(data), "backupFile": backupFilename},
	})
}

// ImportSql SQL/ZIP 文件导入（先全库备份）。from: controller/index.js:184-233
//
// 🔒 SYNC-A27（2026-10-12）：上限改回 **100MB**，与 Node 的 MAX_FILE_SIZE 一致
//
//	（controller/index.js:185,190）。原 Go 按「fix BUG-013 有意加固」设为 10MB，
//	与基准差 10 倍 —— 合法的大库备份 SQL 会被直接拒掉，且错误文案也不同。
//	Node 侧的加固点在于「上传落盘后再判大小」，Go 侧保留 stageMultipart 的流式落盘，
//	并在解析前用 maxFileSize 拦截（等价防护，不额外降额）。
func ImportSql(w http.ResponseWriter, r *http.Request) {
	const maxFileSize = 100 * 1024 * 1024 // 对齐 Node MAX_FILE_SIZE
	form, err := stageMultipart(r, "file", 1)
	if err != nil {
		resp.JSON(w, 200, map[string]any{"status": 500, "message": "SQL 导入失败"})
		return
	}
	if len(form.Files) == 0 {
		resp.JSON(w, 200, map[string]any{"status": 400, "message": "请上传 SQL 或 ZIP 文件"})
		return
	}
	file := form.Files[0]
	defer removeIfExists(file.Path)

	ext := strings.ToLower(filepath.Ext(file.OrigName))
	if ext != ".sql" && ext != ".zip" {
		removeIfExists(file.Path)
		resp.JSON(w, 200, map[string]any{"status": 400, "message": "仅支持 .sql 或 .zip 文件"})
		return
	}
	if file.TooLarge || file.Size > maxFileSize {
		removeIfExists(file.Path)
		resp.JSON(w, 200, map[string]any{"status": 400, "message": "文件超过 100MB 限制"})
		return
	}

	var sqlContent string
	if ext == ".zip" {
		content, err := unzipFindSQL(file.Path)
		if err != nil {
			resp.JSON(w, 200, map[string]any{"status": 400, "message": "ZIP 文件中未找到 .sql 文件"})
			return
		}
		sqlContent = content
	} else {
		raw, err := os.ReadFile(file.Path)
		if err != nil {
			resp.JSON(w, 200, map[string]any{"status": 500, "message": "SQL 导入失败"})
			return
		}
		sqlContent = string(raw)
	}

	if strings.TrimSpace(sqlContent) == "" {
		resp.JSON(w, 200, map[string]any{"status": 400, "message": "SQL 内容为空"})
		return
	}
	if !sqlValidRe.MatchString(sqlContent) {
		resp.JSON(w, 200, map[string]any{"status": 400, "message": "未检测到有效的 SQL 语句"})
		return
	}

	// 全库备份
	_, zipFilename, _, _, err := backupAllTablesToZip(true)
	if err != nil {
		// 🔒 SYNC-A43（2026-10-13）：对齐 Node dataManager/controller/index.js:229-232
		//     return res.json({ status: 500, ...buildErrorBody('SQL 导入失败', error) });
		// buildErrorDetail 在**生产环境返回 {}** ⇒ Node 生产响应只有 {status, message:'SQL 导入失败'}，
		// 连 error 字段都没有。旧实现把 mysqldump 的原始 stderr（含 DB 账号/主机/库表清单）、
		// 文件路径、连接错误直接当 message 回显 ⇒ 生产信息泄露。
		// HTTP 状态沿用 Node：res.json（200）+ body.status=500。
		resp.JSON(w, 200, map[string]any{"status": 500, "message": "SQL 导入失败"})
		return
	}

	// keep BUG-059：按 `;`+换行 切分不可靠、非事务，维持原样
	statements := splitSqlStatements(sqlContent)
	executedCount, errorCount := 0, 0
	var errs []map[string]any
	for i, stmt := range statements {
		if stmt == "" {
			continue
		}
		if _, err := db.DB().Exec(stmt); err != nil {
			errorCount++
			// 🔒 SYNC-A43（2026-10-13）：按 rune 截断而非按字节。
			// 旧实现 snippet[:100] 是字节切片，会把第 100 字节处的 UTF-8 多字节序列
			// 切成非法字节，encoding/json 序列化时替换成 U+FFFD 乱码。
			// SQL 失败语句里含中文（comments / 字符串字面量）很常见，
			// 第 100 字节落在汉字中间的概率约 1/3 ⇒ 错误明细出现乱码。
			// Node 用 stmt.substring(0,100)（UTF-16 code unit），对 BMP 字符
			// 与 rune 计数一致（中文各 1 个），仅 emoji 等增补平面有差异。
			snippet := stmt
			if r := []rune(snippet); len(r) > 100 {
				snippet = string(r[:100])
			}
			errs = append(errs, map[string]any{"index": i + 1, "sql": snippet, "message": err.Error()})
		} else {
			executedCount++
		}
	}

	_ = os.Remove(file.Path)
	success := errorCount == 0
	// 🔒 SYNC-A27：失败明细截断到前 20 条（Node errors.slice(0, 20)，
	//   controller/index.js:227）—— 大文件可回吐数千条，把响应撑爆。
	if len(errs) > 20 {
		errs = errs[:20]
	}
	body := map[string]any{
		"status":  207,
		"message": "执行完成，" + strconv.Itoa(executedCount) + " 条成功，" + strconv.Itoa(errorCount) + " 条失败",
		"data": map[string]any{
			"executedCount": executedCount, "errorCount": errorCount,
			"errors": errs, "backupFile": zipFilename,
			"backupTimestamp": time.Now().Format("2006-01-02 15:04:05"),
		},
	}
	if success {
		body["status"] = 200
		body["message"] = "SQL 导入成功，共执行 " + strconv.Itoa(executedCount) + " 条语句"
	}
	resp.JSON(w, 200, body)
}

// sqlValidRe 对应 /(CREATE|INSERT|ALTER|DROP)\s/i。
var sqlValidRe = regexp.MustCompile(`(?i)(CREATE|INSERT|ALTER|DROP)\s`)

// splitSqlRe 对应 /;\s*\r?\n/（keep BUG-059：朴素切分）。
var splitSqlRe = regexp.MustCompile(`;\s*\r?\n`)

// splitSqlStatements 对应 sqlContent.split(/;\s*\r?\n/) + filter。
func splitSqlStatements(sqlContent string) []string {
	parts := splitSqlRe.Split(sqlContent, -1)
	out := []string{}
	for _, s := range parts {
		s = strings.TrimSpace(s)
		if len(s) == 0 {
			continue
		}
		if strings.HasPrefix(s, "--") || strings.HasPrefix(s, "#") || strings.HasPrefix(s, "/*") {
			continue
		}
		out = append(out, s)
	}
	return out
}

// GetBackupList 获取备份列表。from: controller/index.js:232-239
func GetBackupList(w http.ResponseWriter, r *http.Request) {
	backups, err := listBackups()
	if err != nil {
		resp.JSON(w, 200, map[string]any{"status": 500, "message": "获取备份列表失败"})
		return
	}
	resp.JSON(w, 200, map[string]any{"status": 200, "data": backups})
}

// CreateSystemBackup 创建系统备份（异步任务）。from: controller/index.js:242-265
func CreateSystemBackup(w http.ResponseWriter, r *http.Request) {
	// 并发保护
	if running := getRunningTask("system_backup"); running != nil {
		resp.JSON(w, 200, map[string]any{
			"status": 202, "message": "已有系统备份任务正在执行中",
			"data": map[string]any{"taskId": running.ID, "status": running.Status, "reuseExisting": true},
		})
		return
	}
	task := createSystemBackupTask(map[string]any{"includeData": true})
	resp.JSON(w, 200, map[string]any{
		"status": 202, "message": "系统备份任务已提交，正在后台执行（完整备份 + 仅结构备份）",
		"data": map[string]any{"taskId": task.ID, "status": task.Status},
	})
}

// GetSystemBackups 获取系统备份列表。from: controller/index.js:267-275
func GetSystemBackups(w http.ResponseWriter, r *http.Request) {
	list, err := listSystemBackups()
	if err != nil {
		resp.JSON(w, 200, map[string]any{"status": 500, "message": "获取系统备份列表失败"})
		return
	}
	resp.JSON(w, 200, map[string]any{"status": 200, "data": list})
}

// DeleteBackup 删除备份文件。from: controller/index.js:277-290
func DeleteBackup(w http.ResponseWriter, r *http.Request) {
	filename := r.PathValue("filename")
	if filename == "" || strings.Contains(filename, "..") || strings.Contains(filename, "/") || strings.Contains(filename, "\\") {
		resp.JSON(w, 200, map[string]any{"status": 400, "message": "文件名不合法"})
		return
	}
	if err := deleteBackup(filename); err != nil {
		if err.Error() == "备份文件不存在" {
			resp.JSON(w, 200, map[string]any{"status": 404, "message": "备份文件不存在"})
			return
		}
		resp.JSON(w, 200, map[string]any{"status": 500, "message": "删除备份失败"})
		return
	}
	resp.JSON(w, 200, map[string]any{"status": 200, "message": "删除成功"})
}

// DownloadBackup 下载备份文件。from: controller/index.js:292-309（res.download）
func DownloadBackup(w http.ResponseWriter, r *http.Request) {
	filename := r.PathValue("filename")
	if filename == "" || strings.Contains(filename, "..") || strings.Contains(filename, "/") || strings.Contains(filename, "\\") {
		resp.JSON(w, 200, map[string]any{"status": 400, "message": "文件名不合法"})
		return
	}
	backupDir := getBackupDir()
	filepathOut := filepath.Join(backupDir, filename)
	resolvedPath, err := filepath.Abs(filepathOut)
	if err != nil {
		resp.JSON(w, 200, map[string]any{"status": 403, "message": "禁止访问"})
		return
	}
	resolvedBase, err := filepath.Abs(backupDir)
	if err != nil {
		resp.JSON(w, 200, map[string]any{"status": 403, "message": "禁止访问"})
		return
	}
	if resolvedPath != resolvedBase && !strings.HasPrefix(resolvedPath, resolvedBase+string(filepath.Separator)) {
		resp.JSON(w, 200, map[string]any{"status": 403, "message": "禁止访问"})
		return
	}
	if !fileExists(filepathOut) {
		resp.JSON(w, 200, map[string]any{"status": 404, "message": "备份文件不存在"})
		return
	}
	w.Header().Set("Content-Disposition", "attachment; filename=\""+filename+"\"")
	http.ServeFile(w, r, filepathOut)
}

// GetExportTaskStatus 查询任务状态。from: controller/index.js:313-345
func GetExportTaskStatus(w http.ResponseWriter, r *http.Request) {
	taskID := r.PathValue("taskId")
	if taskID == "" {
		resp.JSON(w, 200, map[string]any{"status": 400, "message": "任务ID不能为空"})
		return
	}
	task := getTaskStatus(taskID)
	if task == nil {
		resp.JSON(w, 200, map[string]any{"status": 404, "message": "任务不存在或已过期"})
		return
	}
	resp.JSON(w, 200, map[string]any{"status": 200, "data": task.toView()})
}

// CancelExportTask 取消任务。from: controller/index.js:347-361
func CancelExportTask(w http.ResponseWriter, r *http.Request) {
	taskID := r.PathValue("taskId")
	if taskID == "" {
		resp.JSON(w, 200, map[string]any{"status": 400, "message": "任务ID不能为空"})
		return
	}
	if cancelTask(taskID) {
		resp.JSON(w, 200, map[string]any{"status": 200, "message": "任务已取消"})
	} else {
		resp.JSON(w, 200, map[string]any{"status": 400, "message": "任务无法取消（可能已完成或不存在）"})
	}
}

// ===== 助手 =====

func isBadTable(err error) bool { return err != nil && err.Error() == errBadTable.Error() }

func orDefault(v, def string) string {
	if v == "" {
		return def
	}
	return v
}

// jsParseInt 对应 parseInt(v, 10)：不可解析 → NaN（Go 以回退默认值表达）。
func jsParseInt(s string) int {
	s = strings.TrimSpace(s)
	end := 0
	for i := 0; i < len(s); i++ {
		c := s[i]
		if (i == 0 && (c == '-' || c == '+')) || (c >= '0' && c <= '9') {
			end = i + 1
			continue
		}
		break
	}
	if end == 0 {
		return 0
	}
	n, err := strconv.Atoi(s[:end])
	if err != nil {
		return 0
	}
	return n
}
