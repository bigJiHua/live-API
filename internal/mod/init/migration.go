package init

// migration.go — 复刻 src/init/migrationRunner.js：
// _migrations 记录表 + 按文件名排序执行 mysql/migrations/*.sql（幂等）。

import (
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"

	"live/api/internal/config"
	"live/api/internal/db"
)

// trackTable 对应 Node TRACK_TABLE = '_migrations'。
const trackTable = "_migrations"

// ensureTrackTable 复刻 migrationRunner.js ensureTrackTable。
func ensureTrackTable(exec db.Commiter) error {
	_, err := exec.Exec("CREATE TABLE IF NOT EXISTS `_migrations` (\n      `filename`    varchar(255) NOT NULL,\n      `applied_at`  datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,\n      PRIMARY KEY (`filename`)\n    ) ENGINE=InnoDB DEFAULT CHARSET=utf8 ROW_FORMAT=DYNAMIC COMMENT='迁移记录表'")
	return err
}

// getApplied 复刻 migrationRunner.js getApplied。
func getApplied(exec db.Commiter) ([]string, error) {
	rows, err := exec.Query("SELECT filename FROM " + quoteId(trackTable) + " ORDER BY filename")
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []string
	for rows.Next() {
		var name string
		if err := rows.Scan(&name); err != nil {
			return nil, err
		}
		out = append(out, name)
	}
	return out, rows.Err()
}

// markApplied 复刻 migrationRunner.js markApplied。
func markApplied(exec db.Commiter, filename string) error {
	_, err := exec.Exec("INSERT INTO "+quoteId(trackTable)+" (filename) VALUES (?)", filename)
	return err
}

// getPendingFiles 复刻 migrationRunner.js getPendingFiles。
func getPendingFiles(applied []string) []string {
	dir := ""
	for _, c := range mysqlDirCandidates {
		p := config.PathUnder(filepath.Join(c, "migrations"))
		if st, err := os.Stat(p); err == nil && st.IsDir() {
			dir = p
			break
		}
	}
	if dir == "" {
		return nil
	}
	entries, err := os.ReadDir(dir)
	if err != nil {
		return nil
	}
	appliedSet := make(map[string]bool, len(applied))
	for _, a := range applied {
		appliedSet[a] = true
	}
	var files []string
	for _, e := range entries {
		if e.IsDir() || !strings.HasSuffix(e.Name(), ".sql") {
			continue
		}
		if !appliedSet[e.Name()] {
			files = append(files, e.Name())
		}
	}
	sort.Strings(files) // Node .sort() 字典序
	return files
}

// stmtSplitRe 对应 Node 的 /;\s*(?:\n|$)/（不拆存储过程分号；迁移文件均为纯 DDL/DML）。
var stmtSplitRe = regexp.MustCompile(`;\s*(?:\n|$)`)

// runFile 复刻 migrationRunner.js runFile：整文件拆分执行 + 重复列/键幂等跳过。
func runFile(exec db.Commiter, filename string) error {
	filePath := ""
	for _, c := range mysqlDirCandidates {
		p := config.PathUnder(filepath.Join(c, "migrations", filename))
		if st, err := os.Stat(p); err == nil && !st.IsDir() {
			filePath = p
			break
		}
	}
	if filePath == "" {
		return fmt.Errorf("迁移文件不存在: %s", filename)
	}
	raw, err := os.ReadFile(filePath)
	if err != nil {
		return err
	}
	// 统一换行符（兼容 Windows CRLF），按 ; 后跟换行或文件结尾拆句
	sql := strings.ReplaceAll(strings.ReplaceAll(string(raw), "\r\n", "\n"), "\r", "\n")
	statements := stmtSplitRe.Split(sql, -1)

	for _, stmt := range statements {
		stmt = strings.TrimSpace(stmt)
		if stmt == "" {
			continue
		}
		// 去掉行内注释（-- 开头的行）
		lines := strings.Split(stmt, "\n")
		kept := make([]string, 0, len(lines))
		for _, l := range lines {
			if !strings.HasPrefix(strings.TrimSpace(l), "--") {
				kept = append(kept, l)
			}
		}
		clean := strings.TrimSpace(strings.Join(kept, "\n"))
		if clean == "" {
			continue
		}

		if _, err := exec.Exec(clean); err != nil {
			// MySQL 5.7 兼容：重复列/键视为已存在（幂等重跑）。
			// C7 审计：ER_DUP_ENTRY 不静默跳过——唯一约束因历史重复数据未建成必须抛错。
			if isDupFieldOrKeyErr(err) {
				fmt.Printf("     ⚠ 已存在，跳过: %s...\n", prefixRunes(clean, 60))
				continue
			}
			return err
		}
	}

	return markApplied(exec, filename)
}

// isDupFieldOrKeyErr 等价 Node 的 ER_DUP_FIELDNAME(1060)/ER_DUP_KEYNAME(1061)。
// go-sql-driver 错误文案：Error 1060: Duplicate column name 'x' / Error 1061: Duplicate key name 'y'。
func isDupFieldOrKeyErr(err error) bool {
	if err == nil {
		return false
	}
	msg := err.Error()
	return strings.Contains(msg, "Duplicate column name") ||
		strings.Contains(msg, "Duplicate key name")
}

// prefixRunes 对应 Node clean.substring(0, 60)（按字节截断，迁移语句均为 ASCII 无差异）。
func prefixRunes(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[:n]
}

// runMigrations 复刻 migrationRunner.js 主入口：只跑未执行的迁移。
func runMigrations(exec db.Commiter) (int, error) {
	fmt.Println("\n🔄 检查增量迁移...")
	if err := ensureTrackTable(exec); err != nil {
		return 0, err
	}

	applied, err := getApplied(exec)
	if err != nil {
		return 0, err
	}
	pending := getPendingFiles(applied)

	if len(pending) == 0 {
		fmt.Println("  ✅ 迁移已是最新")
		return 0, nil
	}

	fmt.Printf("  📋 待执行: %d 个\n", len(pending))
	for _, f := range pending {
		if err := runFile(exec, f); err != nil {
			return 0, err
		}
		fmt.Printf("     ✅ %s\n", f)
	}

	fmt.Println("  🎉 完成")
	return len(pending), nil
}
