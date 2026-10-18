package init

// index.go — 复刻 src/init/index.js：系统初始化主流程。
//
// 完整的初始化流程：
//  1. 检查数据库/表（空库导入 live.sql 自动建表）
//  2. 全量备份 + Schema 同步（仅在 INIT_ENABLE=true 时执行）
//  3. 检查表数量是否正确
//  4. 检查表字段是否完整
//  5. 创建管理员账户（仅在 INIT_ENABLE=true 时）
//  6. 清理 .env 配置（删除敏感信息）
//
// 两条路径：
//   - INIT_ENABLE=false（日常启动）→ 步骤1 + 增量迁移
//   - INIT_ENABLE=true（维护/升级）→ 步骤1~6 全部执行

import (
	"encoding/json"
	"fmt"
	"os"
	"regexp"
	"runtime"
	"sort"
	"strconv"
	"strings"
	"time"

	"live/api/internal/config"
	"live/api/internal/idgen"
	"live/api/internal/mw"
	"live/api/internal/srv"
	"live/api/internal/tim"
)

// fallbackTables 期望表清单兜底值：正常以 live.sql 为唯一真相源动态解析，
// 仅当解析 live.sql 失败时回退到此处硬编码清单，避免与真实结构脱节。
var fallbackTables = []string{
	"account",
	"account_balance",
	"account_transfer",
	"asset_register",
	"asset_snapshot",
	"budget",
	"bus_category",
	"bus_fund_history",
	"bus_recurring",
	"card_base",
	"card_bill",
	"card_log",
	"card_repay",
	"device_crypto",
	"fixed_asset",
	"fund",
	"moment",
	"sys_attachment",
	"todo",
	"user_info",
	"user_log",
	"work_job",
	"work_salary",
	"security_verify_log",
}

// requiredFields 关键表的必填字段（表名 -> 字段列表）。
var requiredFields = map[string][]string{
	"user_info": {"id", "username", "email", "login_pwd", "identity", "create_time", "update_time"},
	"budget":    {"id", "user_id", "title", "budget_type", "budget_amount", "cycle", "create_time", "update_time"},
	"account":   {"id", "user_id", "category_id", "direction", "amount", "trans_date", "create_time"},
	"card_base": {"id", "user_id", "bank_id", "card_type", "last4_no", "open_date", "expire_date"},
}

// initStats 状态统计（对应 Node stats；Node 的 stats.checks.* 在 Go 端拍平为直接字段）。
type initStats struct {
	startTime int64
	endTime   int64
	database  *bool
	sync      *bool
	tables    *bool
	fields    *bool
	admin     *bool
	cleanup   *bool
}

var stats initStats

func boolp(b bool) *bool { return &b }

// checkStatus 按键取检查项状态（printSummary / markInitialized 用）。
func (s *initStats) checkStatus(key string) *bool {
	switch key {
	case "database":
		return s.database
	case "sync":
		return s.sync
	case "tables":
		return s.tables
	case "fields":
		return s.fields
	case "admin":
		return s.admin
	case "cleanup":
		return s.cleanup
	}
	return nil
}

// printDivider 打印分隔线（默认 '─'×50；可传 char 与 length）。
func printDivider(args ...any) {
	c := "─"
	length := 50
	if len(args) > 0 {
		if s, ok := args[0].(string); ok && s != "" {
			c = s
		}
	}
	if len(args) > 1 {
		switch n := args[1].(type) {
		case int:
			length = n
		case string:
			if v, err := strconv.Atoi(n); err == nil {
				length = v
			}
		}
	}
	fmt.Println(strings.Repeat(c, length))
}

// printTitle 打印标题（对应 Node printTitle）。
func printTitle(text string) {
	border := strings.Repeat("═", 50)
	fmt.Printf("\n╔%s╗\n", border)
	padding := 50 - len([]rune(text))
	if padding < 0 {
		padding = 0
	}
	left := padding / 2
	right := padding - left
	fmt.Printf("║%s%s%s║\n", strings.Repeat(" ", left), text, strings.Repeat(" ", right))
	fmt.Printf("╚%s╝\n\n", border)
}

// logInit 记录初始化日志（对应 Node logInit；kind 仅作调用点标注，输出统一带时间戳）。
func logInit(message string, kind ...string) {
	fmt.Printf("  [%s] %s\n", tim.Now().Format("15:04:05"), message)
}

// logSub 打印子步骤（对应 Node logSub：ok→✓ / fail→✗ / warn→⚠ / 默认·）。
func logSub(message string, status ...string) {
	prefix := "·"
	if len(status) > 0 {
		switch status[0] {
		case "ok":
			prefix = "✓"
		case "fail":
			prefix = "✗"
		case "warn":
			prefix = "⚠"
		}
	}
	fmt.Printf("     %s %s\n", prefix, message)
}

// isInitEnabled 检查是否启用初始化（对应 Node isInitEnabled）。
func isInitEnabled() bool { return config.Get("INIT_ENABLE", "false") == "true" }

// printConfig 打印当前配置信息（对应 Node printConfig）。
func printConfig() {
	fmt.Println("  📋 当前配置:")
	fmt.Printf("     数据库: %s:%s/%s\n",
		config.Get("DB_HOST", "localhost"), config.Get("DB_PORT", "3306"), config.Get("DB_NAME", "live"))
	fmt.Printf("     用户名: %s\n", config.Get("DB_USER", "root"))
	fmt.Printf("     管理员: %s\n", config.Get("INIT_ADMIN_USER", "admin"))
	printDivider()
}

// maskEmail 邮箱打码（🔒 P1-10：邮箱是 PII，日志打码；对应 Node logFields.maskEmail）。
func maskEmail(email string) string {
	at := strings.Index(email, "@")
	if at <= 0 {
		return "***"
	}
	return email[:1] + "***" + email[at:]
}

// checkDatabase 步骤 1: 检查数据库和表是否存在，不存在则自动创建。
// 对应 Node index.js checkDatabase。
func checkDatabase() bool {
	fmt.Println("\n📦 [步骤 1/6] 检查数据库和表")
	printDivider()

	dbName := config.Get("DB_NAME", "live")
	logInit(fmt.Sprintf("目标数据库: %s", dbName))
	logInit("正在连接 MySQL 服务器...")

	fail := func(where string, err error) bool {
		logInit(fmt.Sprintf("❌ %s: %s", where, err.Error()), "error")
		logInit("请检查数据库配置和网络连接", "warn")
		stats.database = boolp(false)
		return false
	}

	conn, err := openConn(false)
	if err != nil {
		return fail("连接失败", err)
	}
	rows, qerr := queryRows(conn, fmt.Sprintf("SHOW DATABASES LIKE '%s'", dbName))
	if qerr != nil {
		conn.Close()
		return fail("连接失败", qerr)
	}
	if len(rows) == 0 {
		logInit(fmt.Sprintf("⚠️ 数据库 %s 不存在，尝试自动创建...", dbName), "warn")
		if _, cerr := conn.Exec(fmt.Sprintf(
			"CREATE DATABASE `%s` DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci", dbName)); cerr != nil {
			conn.Close()
			return fail("连接失败", cerr)
		}
		logInit(fmt.Sprintf("✅ 数据库 %s 创建成功", dbName), "success")
	} else {
		logInit(fmt.Sprintf("✅ 数据库 %s 存在", dbName), "success")
	}
	conn.Close()

	// 检查表是否存在
	connDB, err := openConn(true)
	if err != nil {
		return fail("连接失败", err)
	}
	tables, terr := showTables(connDB)
	if terr != nil {
		connDB.Close()
		return fail("连接失败", terr)
	}
	if len(tables) == 0 {
		logInit("⚠️ 数据库中没有表，尝试自动创建...", "warn")
		autoResult := autoInitDatabase()
		if !autoResult.Success {
			logInit(fmt.Sprintf("❌ 表结构创建失败: %s", autoResult.Reason), "error")
			connDB.Close()
			stats.database = boolp(false)
			return false
		}
		logInit("✅ 表结构自动创建成功", "success")
	} else {
		logInit(fmt.Sprintf("✅ 已有 %d 张表，跳过建表", len(tables)))
	}
	connDB.Close()

	stats.database = boolp(true)
	return true
}

// getExpectedTables 从 live.sql 动态解析期望表清单（以 live.sql 为唯一真相源）；
// 解析失败时回退到 fallbackTables。
func getExpectedTables() []string {
	parsed, err := parseLiveSQLFile()
	if err == nil {
		if len(parsed.Order) > 0 {
			return parsed.Order
		}
		return fallbackTables
	}
	msg := err.Error()
	logInit(fmt.Sprintf("⚠️ 解析 live.sql 失败，使用内置兜底表清单: %s", msg), "warn")
	return fallbackTables
}

// checkTableCount 步骤 3: 检查表数量（对应 Node checkTableCount）。
func checkTableCount() bool {
	fmt.Println("\n📋 [步骤 3/6] 检查数据表")
	printDivider()

	expectedTables := getExpectedTables()
	expectedCount := len(expectedTables)
	logInit(fmt.Sprintf("期望表数量: %d（来自 live.sql）", expectedCount))
	logInit("正在查询数据库表...")

	conn, err := openConn(true)
	if err != nil {
		logInit(fmt.Sprintf("❌ 查询失败: %s", err.Error()), "error")
		logInit("表查询失败", "warn")
		stats.tables = boolp(false)
		return false
	}
	existingTables, qerr := showTables(conn)
	conn.Close()
	if qerr != nil {
		logInit(fmt.Sprintf("❌ 查询失败: %s", qerr.Error()), "error")
		logInit("表查询失败", "warn")
		stats.tables = boolp(false)
		return false
	}

	existingCount := len(existingTables)
	logInit(fmt.Sprintf("实际表数量: %d", existingCount))

	if existingCount == 0 {
		logInit("❌ 数据库中没有表", "error")
		logInit("请先执行 SQL 文件创建表结构", "warn")
		stats.tables = boolp(false)
		return false
	}

	existingSet := make(map[string]bool, len(existingTables))
	for _, t := range existingTables {
		existingSet[t] = true
	}

	if existingCount < expectedCount {
		var missing []string
		for _, t := range expectedTables {
			if !existingSet[t] {
				missing = append(missing, t)
			}
		}
		logInit(fmt.Sprintf("⚠️ 缺少 %d 张表:", len(missing)), "warn")
		for _, t := range missing {
			logSub(t, "fail")
		}
		stats.tables = boolp(false)
		return false
	}

	if existingCount > expectedCount {
		logInit(fmt.Sprintf("⚠️ 表数量超出预期 (%d > %d)", existingCount, expectedCount), "warn")
		logInit("多出的表可能是自定义表，不影响使用", "warn")
	}

	// 列出所有期望表的存在状态
	fmt.Println("\n  表清单:")
	for i, tableName := range expectedTables {
		status := "fail"
		if existingSet[tableName] {
			status = "ok"
		}
		logSub(fmt.Sprintf("%02d. %s", i+1, tableName), status)
	}

	logInit(fmt.Sprintf("✅ 表数量检查通过 (%d/%d)", existingCount, expectedCount), "success")
	stats.tables = boolp(true)
	return true
}

// checkTableFields 步骤 4: 检查关键表字段（对应 Node checkTableFields）。
// Node 遍历 Object.entries(REQUIRED_FIELDS)（插入序）；Go map 无序，按表名排序保证输出可复现。
func checkTableFields() {
	fmt.Println("\n🔍 [步骤 4/6] 检查表字段")
	printDivider()

	tableCount := len(requiredFields)
	logInit(fmt.Sprintf("将检查 %d 张关键表的字段完整性", tableCount))

	allFieldsOK := true
	checkedCount := 0
	okCount := 0
	warnCount := 0

	names := make([]string, 0, len(requiredFields))
	for name := range requiredFields {
		names = append(names, name)
	}
	sort.Strings(names)

	conn, err := openConn(true)
	if err != nil {
		logInit(fmt.Sprintf("❌ 检查失败: %s", err.Error()), "error")
		stats.fields = boolp(false)
		return
	}
	defer conn.Close()

	for _, tableName := range names {
		required := requiredFields[tableName]
		checkedCount++
		logInit(fmt.Sprintf("\n  检查 [%d/%d] %s...", checkedCount, tableCount, tableName))

		rows, qerr := queryRows(conn, "SHOW COLUMNS FROM "+tableName)
		if qerr != nil {
			logSub("表不存在或查询失败", "fail")
			allFieldsOK = false
			warnCount++
			continue
		}
		actualSet := make(map[string]bool, len(rows))
		for _, r := range rows {
			actualSet[r["Field"]] = true
		}

		var missing []string
		for _, f := range required {
			if !actualSet[f] {
				missing = append(missing, f)
			}
		}
		if len(missing) > 0 {
			logSub(fmt.Sprintf("缺少字段: %s", strings.Join(missing, ", ")), "fail")
			allFieldsOK = false
			warnCount++
		} else {
			logSub(fmt.Sprintf("字段完整 (%d 个)", len(rows)), "ok")
			okCount++
		}

		// 列出必填字段状态
		for _, f := range required {
			if actualSet[f] {
				logSub("   ✓ "+f, "ok")
			} else {
				logSub("   ✗ "+f, "fail")
			}
		}
	}

	printDivider()
	logInit(fmt.Sprintf("字段检查完成: %d 张通过, %d 张有问题", okCount, warnCount))

	if allFieldsOK {
		logInit("✅ 所有关键表字段完整", "success")
	} else {
		logInit("⚠️ 部分表字段缺失，建议重新执行 SQL 文件", "warn")
	}

	stats.fields = boolp(allFieldsOK)
}

// createAdmin 步骤 5: 检查/创建管理员（对应 Node createAdmin）。
// 返回 (created/已存在, error)：查询异常（无法确认管理员状态）返回 error 上抛，
// 由 init 终止并报错——静默跳过会导致空库部署漏建管理员（本项目不开放注册）。
func createAdmin() (bool, error) {
	fmt.Println("\n👤 [步骤 5/6] 管理账户")
	printDivider()

	username := config.Get("INIT_ADMIN_USER", "admin")
	password := config.Get("INIT_ADMIN_PASS", "admin123")
	email := config.Get("INIT_ADMIN_EMAIL", "admin@example.com")

	logInit(fmt.Sprintf("目标账户: %s", username))
	// 🔒 P1-10（复审补漏）：邮箱是 PII，日志打码；密码只显示强度不显示内容
	strength := "建议使用更长的密码"
	if len(password) >= 8 {
		strength = "安全"
	}
	logInit(fmt.Sprintf("密码强度: %s (%d 位)", strength, len(password)))
	logInit(fmt.Sprintf("邮箱: %s", maskEmail(email)))
	printDivider()

	// 检查是否已存在管理员（按 identity='admin' 查，而非按 username，避免重复创建）
	logInit("正在检查账户...")

	conn, err := openConn(true)
	if err != nil {
		logInit(fmt.Sprintf("查询管理员失败: %s", err.Error()), "error")
		logInit("无法确认管理员是否存在，终止初始化以避免漏建管理员", "error")
		return false, err
	}
	rows, qerr := queryRows(conn,
		"SELECT id, username, identity, create_time FROM user_info WHERE identity = 'admin' LIMIT 1")
	conn.Close()
	if qerr != nil {
		logInit(fmt.Sprintf("查询管理员失败: %s", qerr.Error()), "error")
		logInit("无法确认管理员是否存在，终止初始化以避免漏建管理员", "error")
		return false, qerr
	}
	if len(rows) > 0 {
		admin := rows[0]
		logInit("⏭️ 管理员已存在，跳过创建", "skip")
		fmt.Println("\n  账户信息:")
		logSub(fmt.Sprintf("用户名: %s", admin["username"]))
		logSub(fmt.Sprintf("身份: %s", admin["identity"]))
		logSub(fmt.Sprintf("创建时间: %s", admin["create_time"]))
		stats.admin = boolp(true)
		return true, nil
	}

	printDivider()
	logInit("开始创建管理员账户...")

	id := idgen.UserID()
	saltRounds := 10
	if v, cerr := strconv.Atoi(config.Get("BCRYPT_SALT_ROUNDS", "10")); cerr == nil {
		saltRounds = v
	}
	logInit(fmt.Sprintf("正在加密密码 (salt rounds: %d)...", saltRounds))
	hashedPassword, herr := mw.BcryptHash(password, saltRounds)
	if herr != nil {
		logInit(fmt.Sprintf("❌ 创建失败: %s", herr.Error()), "error")
		stats.admin = boolp(false)
		return false, nil
	}

	logInit("正在写入数据库...")
	conn2, err := openConn(true)
	if err != nil {
		logInit(fmt.Sprintf("❌ 创建失败: %s", err.Error()), "error")
		stats.admin = boolp(false)
		return false, nil
	}
	_, err = conn2.Exec(
		"INSERT INTO user_info (id, username, email, login_pwd, identity, create_time, update_time) VALUES (?, ?, ?, ?, ?, ?, ?)",
		id, username, email, hashedPassword, "admin", tim.NowMS(), tim.FmtDateTime(tim.Now()))
	conn2.Close()
	if err != nil {
		logInit(fmt.Sprintf("❌ 创建失败: %s", err.Error()), "error")
		stats.admin = boolp(false)
		return false, nil
	}

	fmt.Println("\n  ✅ 管理员创建成功!")
	fmt.Println("\n  账户信息:")
	logSub(fmt.Sprintf("用户名: %s", username))
	logSub(fmt.Sprintf("密码: %s", password))
	logSub("身份: admin")

	stats.admin = boolp(true)
	return true, nil
}

// cleanupEnvFile 步骤 6: 清理 .env 文件（对应 Node cleanupEnvFile）。
// 保留 INIT 开关（仅改写值），删除初始管理员账户配置与相关注释行。
var (
	reEnvInitEnable = regexp.MustCompile(`(?m)^INIT_ENABLE\s*=.*$`)
	reEnvInitSkip   = regexp.MustCompile(`(?m)^INIT_SKIP\s*=.*$`)
	// 1) 保留 INIT 开关（INIT_SKIP / INIT_ENABLE），仅改写其值（而非删除）
	//    - INIT_ENABLE: 深度初始化已完成 → 置 false（下次进入日常增量迁移模式）
	//    - INIT_SKIP: 恢复跳过 → 置 true（下次启动完全跳过 init，日常快启；
	//      如需再次初始化再手动改为 false）
	reInitAdminKeys = regexp.MustCompile(`(?m)^(INIT_ADMIN_USER|INIT_ADMIN_PASS|INIT_ADMIN_EMAIL)\s*=.*\n?`)
	// 3) 删除管理员相关的注释行（保留「系统初始化配置 / INIT_SKIP / INIT_ENABLE」的说明注释）
	reAdminComments = regexp.MustCompile(`(?m)^#.*(初始管理员|INIT_ADMIN|如果不设置).*\n?`)
	reMultiBlank    = regexp.MustCompile(`\n{3,}`)
)

func cleanupEnvFile() {
	fmt.Println("\n🧹 [步骤 6/6] 清理配置")
	printDivider()

	envPath := projectFilePath(".env")

	logInit("正在清理初始化配置...")

	raw, err := os.ReadFile(envPath)
	if err != nil {
		logInit("⚠️ .env 文件不存在，跳过", "warn")
		stats.cleanup = boolp(true)
		return
	}
	content := string(raw)
	originalLength := len(content)

	content = reEnvInitEnable.ReplaceAllString(content, "INIT_ENABLE=false")
	content = reEnvInitSkip.ReplaceAllString(content, "INIT_SKIP=true")

	// 2) 删除初始管理员账户配置（仅在 INIT_ENABLE=true 时生效，初始化后不再需要）
	content = reInitAdminKeys.ReplaceAllString(content, "")

	// 3) 删除管理员相关的注释行（保留「系统初始化配置 / INIT_SKIP / INIT_ENABLE」的说明注释）
	content = reAdminComments.ReplaceAllString(content, "")

	// 4) 清理连续空行 + 移除末尾空行
	content = reMultiBlank.ReplaceAllString(content, "\n\n")
	content = strings.TrimSpace(content) + "\n"

	if werr := os.WriteFile(envPath, []byte(content), 0644); werr != nil {
		logInit(fmt.Sprintf("❌ 清理失败: %s", werr.Error()), "error")
		stats.cleanup = boolp(false)
		return
	}

	removedBytes := originalLength - len(content)
	logInit("✅ 深度初始化已关闭（INIT_ENABLE=false），并移除管理员初始配置")
	logSub(fmt.Sprintf("移除内容大小: %d 字节；INIT_SKIP 已恢复为 true（下次启动跳过 init，日常快启）", removedBytes))

	// 验证清理结果（INIT 开关应保留，仅检查管理员配置是否已删除）
	verify, verr := os.ReadFile(envPath)
	if verr == nil {
		stillHasAdmin := strings.Contains(string(verify), "INIT_ADMIN_USER") ||
			strings.Contains(string(verify), "INIT_ADMIN_PASS") ||
			strings.Contains(string(verify), "INIT_ADMIN_EMAIL")
		if stillHasAdmin {
			logInit("⚠️ 管理员配置未清理干净，请手动检查 .env", "warn")
		}
	}

	stats.cleanup = boolp(true)
}

// markInitialized 记录初始化完成标记（对应 Node markInitialized：写 .init.flag）。
func markInitialized() {
	flagPath := projectFilePath(".init.flag")
	flagData := map[string]any{
		"initializedAt": tim.NowMS(),
		"timestamp":     tim.FmtDateTime(tim.Now()),
		"version":       "1.0.0",
		"checks": map[string]any{
			"database": stats.database,
			"sync":     stats.sync,
			"tables":   stats.tables,
			"fields":   stats.fields,
			"admin":    stats.admin,
			"cleanup":  stats.cleanup,
		},
	}
	buf, err := json.MarshalIndent(flagData, "", "  ")
	if err != nil {
		logSub(fmt.Sprintf("标记文件创建失败: %s", err.Error()), "warn")
		return
	}
	if err := os.WriteFile(flagPath, buf, 0644); err != nil {
		logSub(fmt.Sprintf("标记文件创建失败: %s", err.Error()), "warn")
		return
	}
	logSub("标记文件: .init.flag")
}

// printSummary 打印初始化摘要（对应 Node printSummary）。
func printSummary(success bool) {
	stats.endTime = time.Now().UnixMilli()
	totalTime := stats.endTime - stats.startTime

	fmt.Print("\n")
	printDivider("═")

	fmt.Print("\n📊 初始化摘要\n\n")

	fmt.Println("  检查项                    状态")
	printDivider("─", 40)

	checkNames := []struct{ key, name string }{
		{"database", "数据库连接"},
		{"sync", "备份与同步"},
		{"tables", "数据表检查"},
		{"fields", "字段完整性"},
		{"admin", "管理员账户"},
		{"cleanup", "配置清理"},
	}
	for _, c := range checkNames {
		status := stats.checkStatus(c.key)
		statusText, statusType := "⏸️ 跳过", "warn"
		if status != nil {
			if *status {
				statusText, statusType = "✅ 通过", "ok"
			} else {
				statusText, statusType = "❌ 失败", "fail"
			}
		}
		logSub(fmt.Sprintf("%-20s %s", c.name, statusText), statusType)
	}

	printDivider("─", 40)
	logSub(fmt.Sprintf("总耗时: %dms", totalTime))

	fmt.Print("\n")
	printDivider("═")

	if success {
		fmt.Print("\n  🎉 初始化成功! 系统已就绪\n\n")
		printTitle("INIT COMPLETE")
	} else {
		fmt.Print("\n  ⚠️ 初始化部分完成，请检查上述错误\n\n")
		printTitle("INIT PARTIAL")
	}
}

// ---------- 主初始化流程 ----------

// initOutcome 对应 Node init() 的返回 { success, step, skipped, reason, fatal }。
// 🔒 2026-10-13（api.md P2-15）：新增 Fatal —— 迁移/schema 同步失败 = schema 与代码不一致，
//
//	必须致命：由 startupInit fail-fast 拒绝启动（INIT_STRICT=false 可强制）。
type initOutcome struct {
	Success bool
	Step    int
	Skipped bool
	Reason  string
	Fatal   bool
}

// runInit 复刻 index.js 的 async function init()。
func runInit() initOutcome {
	stats = initStats{}
	stats.startTime = time.Now().UnixMilli()

	printTitle("SYSTEM INIT")

	fmt.Print("🔧 系统初始化程序启动...\n\n")
	logInit(fmt.Sprintf("开始时间: %s", tim.FmtDateTime(tim.Now())))
	logInit(fmt.Sprintf("Go 版本: %s", runtime.Version()))
	logInit(fmt.Sprintf("运行环境: %s", config.Get("NODE_ENV", "development")))

	// 显示配置
	printConfig()

	// 数据库检查始终执行
	allPassed := true

	// 步骤 1: 检查/创建数据库（始终执行）
	if !checkDatabase() {
		allPassed = false
		fmt.Print("\n\n")
		printDivider()
		logInit("❌ 数据库检查失败，初始化终止", "error")
		logInit("请先确保数据库已创建并可连接", "warn")
		printSummary(false)
		return initOutcome{false, 1, false, "", false}
	}

	// 检查是否启用完整初始化（创建管理员等）
	if !isInitEnabled() {
		// 日常启动：只跑增量迁移（不备份，不 sync）
		// ⚠ 不调用 ensureMissingTables：结构变更必须严格走迁移脚本（审计 P9），
		//   运行时代码自建表会绕过迁移记录且不做备份。
		conn, err := openConn(true)
		if err != nil {
			fmt.Print("\n\n")
			printDivider()
			logInit(fmt.Sprintf("❌ 初始化失败: %s", err.Error()), "error")
			logInit("请检查数据库连接和配置后重试", "warn")
			printSummary(false)
			return initOutcome{false, 0, false, err.Error(), false}
		}
		if _, err := runMigrations(conn); err != nil {
			conn.Close()
			fmt.Print("\n\n")
			printDivider()
			// 🔒 2026-10-13（api.md P2-15）：迁移失败 = schema 与代码不一致，必须致命。
			//    原实现仅打印后继续返回 success=false，而 startupInit 忽略返回值
			//    ⇒ 服务带病启动（缺列/缺表），依赖新 schema 的功能随后全量 500
			//    而进程守护毫无察觉。现在打 fatal 标记，由 startupInit 拒绝启动
			//    （INIT_STRICT=false 可强制）。
			logInit(fmt.Sprintf("❌ 增量迁移失败: %s", err.Error()), "error")
			logInit("数据库结构与代码不一致，服务将不启动（设 INIT_STRICT=false 可强制）", "warn")
			printSummary(false)
			return initOutcome{false, 0, false, err.Error(), true}
		}
		conn.Close()

		fmt.Println("\n⏭️ [跳过] 管理员创建未启用 (INIT_ENABLE≠true)")
		logInit("提示: 如需创建管理员，请在 .env 中设置 INIT_ENABLE=true")
		logInit("数据库结构由迁移脚本保障 ✓")
		printSummary(true)
		return initOutcome{true, 0, true, "admin_disabled", false}
	}

	logInit("初始化已启用，开始执行检测...\n")

	dbName := config.Get("DB_NAME", "live")
	conn, err := openConn(true)
	if err != nil {
		fmt.Print("\n\n")
		printDivider()
		logInit(fmt.Sprintf("❌ 初始化失败: %s", err.Error()), "error")
		logInit("请检查数据库连接和配置后重试", "warn")
		printSummary(false)
		return initOutcome{false, 0, false, err.Error(), false}
	}

	// ========== INIT_ENABLE=true：先备份，再以 live.sql 为唯一真相源同步 ==========
	fmt.Println("\n💾 [步骤 2/6] 备份与 Schema 同步")
	printDivider()

	// 2.1 ⚠ 必须先全量备份原始数据库
	if _, err := fullBackup(conn, dbName); err != nil {
		conn.Close()
		return syncFailed(err)
	}

	// 2.2 以 live.sql 为基准对齐实际库结构（补列、删列、改类型）
	if _, err := syncSchema(conn); err != nil {
		conn.Close()
		return syncFailed(err)
	}
	stats.sync = boolp(true)

	// 2.3 执行增量迁移（如 password_changed_at 等新字段）
	if _, err := runMigrations(conn); err != nil {
		conn.Close()
		return syncFailed(err)
	}
	conn.Close()

	// 步骤 3: 检查表数量
	if !checkTableCount() {
		allPassed = false
		fmt.Print("\n\n")
		printDivider()
		logInit("⚠️ 表检查未完全通过，继续执行...", "warn")
	}

	// 步骤 4: 检查表字段
	checkTableFields()

	// 步骤 5: 创建管理员
	adminOK, adminErr := createAdmin()
	if adminErr != nil {
		fmt.Print("\n\n")
		printDivider()
		logInit(fmt.Sprintf("❌ 初始化失败: %s", adminErr.Error()), "error")
		logInit("请检查数据库连接和配置后重试", "warn")
		printSummary(false)
		return initOutcome{false, 0, false, adminErr.Error(), false}
	}
	if !adminOK {
		allPassed = false
		fmt.Print("\n\n")
		printDivider()
		logInit("❌ 管理员创建失败，初始化终止", "error")
		printSummary(false)
		return initOutcome{false, 5, false, "", false}
	}

	// 步骤 6: 清理配置
	cleanupEnvFile()

	// 标记完成
	markInitialized()

	// 打印摘要
	printSummary(allPassed)

	return initOutcome{allPassed, 0, false, "", false}
}

// syncFailed 对应 Node 步骤 2 失败分支：保留 INIT_ENABLE 以便下次重试，不清理 .env。
// 🔒 2026-10-13（api.md P2-15）：schema 未就绪同样致命（live.sql 基准没落地，后续功能全 500），
//
//	打 fatal 让 startupInit 拒绝启动（INIT_STRICT=false 可强制）。
func syncFailed(err error) initOutcome {
	fmt.Printf("❌ Schema 同步失败: %s\n", err.Error())
	fmt.Println("   数据库已备份，但同步未完成。请修复后重新启动。")
	stats.sync = boolp(false)
	stats.fields = boolp(false)
	printSummary(false)
	return initOutcome{false, 2, false, err.Error(), true}
}

// startupInit 对应 app.js listen 回调中的初始化段：
// INIT_SKIP=true 跳过整个初始化流程（用于排查问题或紧急重启）。
// 🔒 2026-10-13（api.md P2-15）：init 返回 fatal ⇒ 拒绝启动（fail-fast）。
//
//	原实现忽略 runInit() 返回值 ⇒ 服务带病启动：缺列/缺表时进程守护看它活着
//	就不告警，而依赖新 schema 的接口随后全量 500（表现为"服务正常但功能全挂"）。
//	现在 fatal 时直接 exit(1)，由 pm2/systemd/docker 的重试策略形成告警循环，
//	修复数据库后下次重启自动恢复。紧急逃生阀：INIT_STRICT=false 强制启动。
func startupInit() {
	if os.Getenv("INIT_SKIP") == "true" {
		fmt.Println("⏭️  跳过系统初始化（INIT_SKIP=true）")
	} else {
		outcome := runInit()
		if outcome.Fatal && os.Getenv("INIT_STRICT") != "false" {
			fmt.Fprintln(os.Stderr,
				"[启动中止] 系统初始化/数据库迁移失败（fatal），服务未启动。\n"+
					"          请按上方错误修复后重试；紧急情况下可设 INIT_STRICT=false 强制启动\n"+
					"          （不推荐：schema 与代码不一致将导致相关功能全部 500）。")
			os.Exit(1)
		}
	}
	// 🔒 SYNC-A33（2026-10-12）：注册分期扫描 cron —— 必须在 init 之后、
	//   且**无条件**执行（对齐 app.js:225-239：INIT_SKIP 只是跳过 init 段，
	//   cron 注册在 if/else 之外）。原实现在 cron.go 的 init() 里注册，
	//   而 Go init() 按文件名字母序执行（cron.go < index.go）⇒ cron 先于建表/迁移，
	//   INSTALLMENT_SCAN_FIRST_DELAY=0 时会在表还没建好时扫库。
	startInstallmentCron()
}

func init() {
	srv.OnStartup(startupInit)
}
