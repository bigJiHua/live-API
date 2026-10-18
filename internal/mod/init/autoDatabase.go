package init

// autoDatabase.go — 复刻 src/init/autoDatabase.js：
// 空库时读取 mysql/live.sql 自动建库建表（整文件多语句执行）。

import (
	"database/sql"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"live/api/internal/config"
	"live/api/internal/db"
)

// mysqlDirCandidates mysql 目录的候选相对路径（相对进程 cwd）。
// Node: path.join(__dirname, '../../mysql') → api/mysql（Node 进程 cwd 为 api/）。
// Go 进程 cwd 通常为 API_Go/，等价相对路径为 ../api/mysql；同时兼容从 live/、api/ 启动。
var mysqlDirCandidates = []string{"../api/mysql", "api/mysql", "mysql"}

// apiRoot 定位 api 项目根目录（含 mysql/、.env、.init.flag），找不到返回 ""。
func apiRoot() string {
	for _, c := range mysqlDirCandidates {
		dir := config.PathUnder(c)
		if st, err := os.Stat(dir); err == nil && st.IsDir() {
			return filepath.Dir(dir)
		}
	}
	return ""
}

// mysqlFilePath 定位 mysql/<name>，找不到返回 ""（调用方打日志跳过）。
func mysqlFilePath(name string) string {
	for _, c := range mysqlDirCandidates {
		p := config.PathUnder(filepath.Join(c, name))
		if st, err := os.Stat(p); err == nil && !st.IsDir() {
			return p
		}
	}
	return ""
}

// projectFilePath 定位 api 项目根下的 <name>（.env/.init.flag），优先 cwd 下已存在的 .env。
func projectFilePath(name string) string {
	if name == ".env" {
		if _, err := os.Stat(".env"); err == nil {
			return ".env"
		}
	}
	if root := apiRoot(); root != "" {
		return filepath.Join(root, name)
	}
	return name
}

// openConn 打开专用连接（对应 Node getConnectionWithDb / getConnectionWithoutDb）。
// Node 用 multipleStatements=true 整文件执行 live.sql，Go 侧同样开启；单连接串行执行。
func openConn(withDB bool) (*sql.DB, error) {
	name := ""
	if withDB {
		name = config.Get("DB_NAME", "live")
	}
	dsn := fmt.Sprintf("%s:%s@tcp(%s:%s)/%s?parseTime=true&loc=Local&charset=utf8mb4&multiStatements=true&interpolateParams=true",
		config.Get("DB_USER", "root"), config.Get("DB_PASSWORD", ""),
		config.Get("DB_HOST", "localhost"), config.Get("DB_PORT", "3306"), name)
	conn, err := sql.Open("mysql", dsn)
	if err != nil {
		return nil, err
	}
	conn.SetMaxOpenConns(1)
	if err := conn.Ping(); err != nil {
		conn.Close()
		return nil, err
	}
	return conn, nil
}

// autoResult 对应 Node autoInitDatabase 的返回 { success, reason }。
type autoResult struct {
	Success bool
	Reason  string
}

// autoInitDatabase 复刻 autoDatabase.js 主函数。
func autoInitDatabase() autoResult {
	fmt.Println("\n╔══════════════════════════════════════════════╗")
	fmt.Println("║       数据库自动初始化                        ║")
	fmt.Print("╚══════════════════════════════════════════════╝\n\n")

	// 1. 检查 SQL 文件
	fmt.Println("  📄 检查 SQL 文件...")
	sqlPath := mysqlFilePath("live.sql")
	if sqlPath == "" {
		fmt.Printf("  ❌ SQL 文件不存在: %s\n", config.PathUnder(filepath.Join("../api/mysql", "live.sql")))
		return autoResult{false, "sql_file_not_found"}
	}
	st, err := os.Stat(sqlPath)
	if err != nil {
		fmt.Printf("  ❌ SQL 文件不存在: %s\n", sqlPath)
		return autoResult{false, "sql_file_not_found"}
	}
	fmt.Printf("  ✓ SQL 文件存在 (%.1f KB)\n", float64(st.Size())/1024)

	// 2. 读取 SQL 内容
	fmt.Println("  📖 读取 SQL 文件...")
	raw, err := os.ReadFile(sqlPath)
	if err != nil {
		fmt.Printf("  ❌ 读取失败: %s\n", err.Error())
		return autoResult{false, "sql_file_not_found"}
	}
	sqlContent := strings.ReplaceAll(strings.ReplaceAll(string(raw), "\r\n", "\n"), "\r", "\n")
	fmt.Printf("  ✓ SQL 文件已读取 (%d 字符)\n", len(sqlContent))

	// 3. 创建数据库
	if !createDatabase() {
		return autoResult{false, "database_creation_failed"}
	}

	// 4. 执行 SQL 文件
	if !importSqlFile(sqlContent) {
		return autoResult{false, "sql_execution_failed"}
	}

	// 5. 验证
	if !verifyTables() {
		return autoResult{false, "verification_failed"}
	}

	fmt.Print("\n✅ 数据库初始化完成！\n\n")
	return autoResult{true, ""}
}

// createDatabase 复刻 autoDatabase.js createDatabase。
func createDatabase() bool {
	dbName := config.Get("DB_NAME", "live")
	fmt.Printf("  🗄️  创建数据库: %s...\n", dbName)

	conn, err := openConn(false)
	if err != nil {
		fmt.Printf("  ❌ 创建数据库失败: %s\n", err.Error())
		return false
	}
	defer conn.Close()

	rows, err := conn.Query(fmt.Sprintf("SHOW DATABASES LIKE '%s'", dbName))
	if err != nil {
		fmt.Printf("  ❌ 创建数据库失败: %s\n", err.Error())
		rows.Close()
		return false
	}
	exists := rows.Next()
	rows.Close()
	if err := rows.Err(); err != nil {
		fmt.Printf("  ❌ 创建数据库失败: %s\n", err.Error())
		return false
	}
	if exists {
		fmt.Printf("  ⏭️  数据库 %s 已存在，跳过创建\n", dbName)
		return true
	}

	if _, err := conn.Exec(fmt.Sprintf("CREATE DATABASE `%s` DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci", dbName)); err != nil {
		fmt.Printf("  ❌ 创建数据库失败: %s\n", err.Error())
		return false
	}
	fmt.Printf("  ✅ 数据库 %s 创建成功\n", dbName)
	return true
}

// importSqlFile 复刻 autoDatabase.js importSqlFile：整文件多语句执行。
func importSqlFile(sqlContent string) bool {
	fmt.Println("  📦 执行 SQL 文件...")

	conn, err := openConn(true)
	if err != nil {
		fmt.Printf("  ❌ 执行失败: %s\n", err.Error())
		return false
	}
	defer conn.Close()

	if _, err := conn.Exec(sqlContent); err != nil {
		fmt.Printf("  ❌ 执行失败: %s\n", err.Error())
		return false
	}
	fmt.Println("  ✅ SQL 文件执行成功")
	return true
}

// verifyTables 复刻 autoDatabase.js verifyTables。
func verifyTables() bool {
	fmt.Println("  🔍 验证表结构...")

	conn, err := openConn(true)
	if err != nil {
		fmt.Printf("  ❌ 验证失败: %s\n", err.Error())
		return false
	}
	defer conn.Close()

	tables, err := showTables(conn)
	if err != nil {
		fmt.Printf("  ❌ 验证失败: %s\n", err.Error())
		return false
	}
	fmt.Printf("  ✅ 共 %d 张表\n", len(tables))
	for i, t := range tables {
		fmt.Printf("     %02d. %s\n", i+1, t)
	}
	return len(tables) > 0
}

// showTables 执行 SHOW TABLES 并取首列（对应 Node Object.values(row)[0]）。
func showTables(exec db.Commiter) ([]string, error) {
	rows, err := exec.Query("SHOW TABLES")
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
