package init

// schema.go — 复刻 src/init/schemaSync.js：
// 以 live.sql 为唯一真相源的全量备份 + Schema 同步（补列/删列/改类型/删表/索引，
// COMPACT→DYNAMIC 行格式转换），以及最小补表 ensureMissingTables。
//
// 备份部分为 Node fullBackup 的 1:1 复刻（自导出 SQL 到 mysql/backups/，
// 不依赖 dataManager，故无需注入 BackupHook）。

import (
	"database/sql"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"

	"live/api/internal/config"
	"live/api/internal/db"
	"live/api/internal/tim"
)

// ---------- SQL 解析（from: init/schemaSync.js） ----------

// quoteId 复刻 schemaSync.js quoteId。
func quoteId(name string) string {
	return "`" + strings.ReplaceAll(name, "`", "``") + "`"
}

var reWhitespace = regexp.MustCompile(`\s+`)

// normalizeType 复刻 schemaSync.js normalizeType。
func normalizeType(t string) string {
	return reWhitespace.ReplaceAllString(strings.ToLower(t), "")
}

var (
	reDefaultGenerated = regexp.MustCompile(`default_generated`)
	reCurrentTS        = regexp.MustCompile(`(?i)current_timestamp\(\)`)
)

// normalizeExtra 复刻 schemaSync.js normalizeExtra。
func normalizeExtra(extra string) string {
	s := strings.ToLower(extra)
	s = reDefaultGenerated.ReplaceAllString(s, "")
	s = reCurrentTS.ReplaceAllString(s, "current_timestamp")
	s = reWhitespace.ReplaceAllString(s, " ")
	return strings.TrimSpace(s)
}

var reSurroundQuote = regexp.MustCompile(`(?s)^'(.*)'$`)

// normalizeDefault 复刻 schemaSync.js normalizeDefault（nil = Node 的 null/undefined）。
func normalizeDefault(value *string) string {
	if value == nil {
		return ""
	}
	text := strings.TrimSpace(*value)
	if regexp.MustCompile(`(?i)^null$`).MatchString(text) {
		return ""
	}
	text = reSurroundQuote.ReplaceAllString(text, "$1")
	text = reCurrentTS.ReplaceAllString(text, "CURRENT_TIMESTAMP")
	if strings.EqualFold(text, "current_timestamp") {
		return "CURRENT_TIMESTAMP"
	}
	return text
}

// splitCreateBody 复刻 schemaSync.js splitCreateBody：按顶层逗号拆分（忽略引号内）。
func splitCreateBody(body string) []string {
	var parts []string
	var current strings.Builder
	depth := 0
	var quote byte

	for i := 0; i < len(body); i++ {
		ch := body[i]
		var prev byte
		if i > 0 {
			prev = body[i-1]
		}

		if (ch == '\'' || ch == '"' || ch == '`') && prev != '\\' {
			if quote == ch {
				quote = 0
			} else if quote == 0 {
				quote = ch
			}
		}

		if quote == 0 {
			if ch == '(' {
				depth++
			}
			if ch == ')' {
				depth--
			}
			if ch == ',' && depth == 0 {
				parts = append(parts, strings.TrimSpace(current.String()))
				current.Reset()
				continue
			}
		}
		current.WriteByte(ch)
	}
	if s := strings.TrimSpace(current.String()); s != "" {
		parts = append(parts, s)
	}
	return parts
}

var (
	reColHead   = regexp.MustCompile("(?s)^`([^`]+)`\\s+(.+)$")
	reColType   = regexp.MustCompile(`^([a-zA-Z]+(?:\s*\([^)]+\))?)`)
	reColDflt   = regexp.MustCompile(`(?i)\bDEFAULT\s+('(?:\\'|[^'])*'|NULL|CURRENT_TIMESTAMP(?:\(\))?|[-+]?\d+(?:\.\d+)?|[^\s]+)`)
	reColCommnt = regexp.MustCompile(`(?i)\bCOMMENT\s+'((?:\\'|[^'])*)'`)
	reNotNull   = regexp.MustCompile(`(?i)\bNOT\s+NULL\b`)
	reAutoInc   = regexp.MustCompile(`(?i)\bAUTO_INCREMENT\b`)
	reOnUpdTS   = regexp.MustCompile(`(?i)\bON\s+UPDATE\s+CURRENT_TIMESTAMP(?:\(\))?`)
)

// liveColumn 对应 schemaSync.js parseColumnDefinition 的返回。
type liveColumn struct {
	Name         string
	Type         string
	Nullable     bool
	DefaultValue *string
	Extra        string
	Comment      string
	Definition   string
	Position     int
}

// parseColumnDefinition 复刻 schemaSync.js parseColumnDefinition。
func parseColumnDefinition(definition string, position int) *liveColumn {
	m := reColHead.FindStringSubmatch(definition)
	if m == nil {
		return nil
	}
	name := m[1]
	rest := strings.TrimSpace(m[2])

	typeMatch := reColType.FindStringSubmatch(rest)
	colType := ""
	if typeMatch != nil {
		colType = typeMatch[1]
	} else if fields := strings.Fields(rest); len(fields) > 0 {
		colType = fields[0] // rest.split(/\s+/)[0]
	}

	var defaultValue *string
	if dm := reColDflt.FindStringSubmatch(rest); dm != nil {
		v := dm[1]
		defaultValue = &v
	}

	comment := ""
	if cm := reColCommnt.FindStringSubmatch(rest); cm != nil {
		comment = cm[1]
	}

	var extras []string
	if reAutoInc.MatchString(rest) {
		extras = append(extras, "auto_increment")
	}
	if reOnUpdTS.MatchString(rest) {
		extras = append(extras, "on update CURRENT_TIMESTAMP")
	}

	return &liveColumn{
		Name:         name,
		Type:         colType,
		Nullable:     !reNotNull.MatchString(rest),
		DefaultValue: defaultValue,
		Extra:        normalizeExtra(strings.Join(extras, " ")),
		Comment:      comment,
		Definition:   definition,
		Position:     position,
	}
}

var reKeyHead = regexp.MustCompile("(?is)^(UNIQUE\\s+)?KEY\\s+`([^`]+)`\\s*\\(")

// liveIndex 对应 schemaSync.js parseIndexDefinition 的返回。
type liveIndex struct {
	Name       string
	Columns    []string
	Unique     bool
	Definition string
}

// parseIndexDefinition 复刻 schemaSync.js parseIndexDefinition。
func parseIndexDefinition(definition string) *liveIndex {
	m := reKeyHead.FindStringSubmatch(definition)
	if m == nil {
		return nil
	}

	depth := 1
	var columnsSQL strings.Builder
	rest := definition[len(m[0]):]
	for i := 0; i < len(rest); i++ {
		ch := rest[i]
		if ch == '(' {
			depth++
		}
		if ch == ')' {
			depth--
		}
		if depth == 0 {
			break
		}
		columnsSQL.WriteByte(ch)
	}

	var columns []string
	for _, c := range strings.Split(columnsSQL.String(), ",") {
		c = strings.TrimSpace(c)
		c = strings.ReplaceAll(c, "`", "")
		c = regexp.MustCompile(`\(\d+\)$`).ReplaceAllString(c, "")
		columns = append(columns, c)
	}

	return &liveIndex{
		Name:       m[2],
		Columns:    columns,
		Unique:     m[1] != "",
		Definition: definition,
	}
}

// liveTable 对应 schemaSync.js parseLiveSql 中每张表的产物。
type liveTable struct {
	CreateSQL  string
	Columns    []liveColumn
	PrimaryKey string
	Indexes    []liveIndex
}

// liveSchema 解析结果；Order 保持 live.sql 中的表顺序（对应 Node 对象键序）。
type liveSchema struct {
	Order  []string
	Tables map[string]*liveTable
}

var reCreateTable = regexp.MustCompile("(?s)(CREATE TABLE IF NOT EXISTS `([^`]+)`\\s*\\(([\\s\\S]*?)\\)\\s*ENGINE=[^;]+;)")

// parseLiveSQLFile 复刻 schemaSync.js parseLiveSql：以 live.sql 为唯一真相源。
func parseLiveSQLFile() (*liveSchema, error) {
	path := mysqlFilePath("live.sql")
	if path == "" {
		return nil, fmt.Errorf("live.sql 不存在")
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	content := string(raw)

	out := &liveSchema{Tables: map[string]*liveTable{}}
	for _, match := range reCreateTable.FindAllStringSubmatch(content, -1) {
		createSQL := match[1]
		tableName := match[2]
		body := match[3]

		table := &liveTable{CreateSQL: createSQL}
		for _, item := range splitCreateBody(body) {
			trimmed := strings.TrimSpace(item)
			if trimmed == "" || strings.HasPrefix(trimmed, "--") {
				continue
			}
			if strings.HasPrefix(trimmed, "PRIMARY KEY") {
				if pm := regexp.MustCompile(`PRIMARY KEY \(` + "`([^`]+)`" + `\)`).FindStringSubmatch(trimmed); pm != nil {
					table.PrimaryKey = pm[1]
				}
				continue
			}
			if strings.HasPrefix(trimmed, "KEY ") || strings.HasPrefix(trimmed, "UNIQUE KEY ") {
				if idx := parseIndexDefinition(trimmed); idx != nil {
					table.Indexes = append(table.Indexes, *idx)
				}
				continue
			}
			if col := parseColumnDefinition(trimmed, len(table.Columns)+1); col != nil {
				table.Columns = append(table.Columns, *col)
			}
		}
		out.Tables[tableName] = table
		out.Order = append(out.Order, tableName)
	}
	return out, nil
}

// ---------- 备份（from: init/schemaSync.js fullBackup） ----------

// escapeSQLString 对应 mysql2 conn.escape 的字符串转义。
func escapeSQLString(s string) string {
	var b strings.Builder
	for i := 0; i < len(s); i++ {
		switch c := s[i]; c {
		case 0:
			b.WriteString(`\0`)
		case '\n':
			b.WriteString(`\n`)
		case '\r':
			b.WriteString(`\r`)
		case '\\':
			b.WriteString(`\\`)
		case '\'':
			b.WriteString(`\'`)
		case '"':
			b.WriteString(`\"`)
		case 0x1a:
			b.WriteString(`\Z`)
		default:
			b.WriteByte(c)
		}
	}
	return b.String()
}

// escapeSQLValue 对应 mysql2 conn.escape(row[c])。
func escapeSQLValue(v any) string {
	switch t := v.(type) {
	case nil:
		return "NULL"
	case []byte:
		return "_binary'" + escapeSQLString(string(t)) + "'"
	case string:
		return "'" + escapeSQLString(t) + "'"
	case time.Time:
		return "'" + tim.FmtDateTime(t) + "'"
	case bool:
		if t {
			return "true"
		}
		return "false"
	default:
		return fmt.Sprintf("%v", t)
	}
}

// fullBackup 复刻 schemaSync.js fullBackup：全量导出 live 库为 SQL 文件。
func fullBackup(exec db.Commiter, dbName string) (string, error) {
	backupDir := filepath.Join(config.PathUnder("../api/mysql"), "backups")
	if root := apiRoot(); root != "" {
		backupDir = filepath.Join(root, "mysql", "backups")
	}
	if err := os.MkdirAll(backupDir, 0o755); err != nil {
		return "", err
	}

	now := tim.Now()
	timestamp := now.Format("20060102_150405")
	backupFile := filepath.Join(backupDir, fmt.Sprintf("%s_backup_%s.sql", dbName, timestamp))

	fmt.Printf("\n💾 正在全量备份数据库 `%s` → %s ...\n", dbName, backupFile)

	tables, err := showTables(exec)
	if err != nil {
		return "", err
	}

	var sql strings.Builder
	sql.WriteString(fmt.Sprintf("-- 数据库备份: %s\n-- 备份时间: %s\n\n", dbName, time.Now().UTC().Format(time.RFC3339)))
	sql.WriteString("SET NAMES utf8mb4;\nSET FOREIGN_KEY_CHECKS = 0;\n")
	sql.WriteString(fmt.Sprintf("CREATE DATABASE IF NOT EXISTS %s DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;\n", quoteId(dbName)))
	sql.WriteString(fmt.Sprintf("USE %s;\n\n", quoteId(dbName)))

	for _, tableName := range tables {
		fmt.Printf("    📋 %s ...\n", tableName)

		createRows, err := queryRows(exec, "SHOW CREATE TABLE "+quoteId(tableName))
		if err != nil {
			return "", err
		}
		sql.WriteString("DROP TABLE IF EXISTS " + quoteId(tableName) + ";\n")
		if len(createRows) > 0 {
			sql.WriteString(createRows[0]["Create Table"] + ";\n\n")
		}

		// 写数据（分批写入，避免单条 INSERT 过大超出 max_allowed_packet）
		rows, err := exec.Query("SELECT * FROM " + quoteId(tableName))
		if err != nil {
			return "", err
		}
		cols, err := rows.Columns()
		if err != nil {
			rows.Close()
			return "", err
		}
		const batchSize = 500
		batch := make([][]any, 0, batchSize)
		flush := func() error {
			if len(batch) == 0 {
				return nil
			}
			quoted := make([]string, len(cols))
			for i, c := range cols {
				quoted[i] = quoteId(c)
			}
			sql.WriteString("INSERT INTO " + quoteId(tableName) + " (" + strings.Join(quoted, ", ") + ") VALUES\n")
			for ri, vals := range batch {
				escaped := make([]string, len(vals))
				for i, v := range vals {
					escaped[i] = escapeSQLValue(v)
				}
				sql.WriteString("(" + strings.Join(escaped, ", ") + ")")
				if ri < len(batch)-1 {
					sql.WriteString(",\n")
				} else {
					sql.WriteString(";\n")
				}
			}
			batch = batch[:0]
			return nil
		}
		for rows.Next() {
			vals := make([]any, len(cols))
			ptrs := make([]any, len(cols))
			for i := range vals {
				ptrs[i] = &vals[i]
			}
			if err := rows.Scan(ptrs...); err != nil {
				rows.Close()
				return "", err
			}
			batch = append(batch, vals)
			if len(batch) >= batchSize {
				if err := flush(); err != nil {
					rows.Close()
					return "", err
				}
			}
		}
		if err := rows.Err(); err != nil {
			rows.Close()
			return "", err
		}
		rows.Close()
		if err := flush(); err != nil {
			return "", err
		}
		sql.WriteString("\n")
	}

	sql.WriteString("SET FOREIGN_KEY_CHECKS = 1;\n")
	if err := os.WriteFile(backupFile, []byte(sql.String()), 0o644); err != nil {
		return "", err
	}
	st, err := os.Stat(backupFile)
	if err != nil {
		return "", err
	}
	fmt.Printf("  ✅ 备份完成: %.2f MB\n", float64(st.Size())/1024/1024)
	return backupFile, nil
}

// ---------- Schema 同步（from: init/schemaSync.js） ----------

// dbColumn 对应 getDbSchema 中实际库列（SHOW FULL COLUMNS）。
type dbColumn struct {
	Name     string
	Type     string
	Nullable bool
	Default  *string
	Extra    string
	Comment  string
	Position int
}

// dbIndex 对应 getDbSchema 中实际库索引（SHOW INDEX）。
type dbIndex struct {
	Name    string
	Columns []string
	Unique  bool
}

// dbTable 实际库一张表的结构。
type dbTable struct {
	Columns []dbColumn
	Indexes []dbIndex
}

// queryRows 通用行扫描：结果集读成 []map[string]string（NULL → ""），
// 对应 Node mysql2 返回的动态行对象。
func queryRows(exec db.Commiter, query string) ([]map[string]string, error) {
	rows, err := exec.Query(query)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	cols, err := rows.Columns()
	if err != nil {
		return nil, err
	}
	var out []map[string]string
	for rows.Next() {
		ptrs := make([]sql.NullString, len(cols))
		vals := make([]any, len(cols))
		for i := range ptrs {
			vals[i] = &ptrs[i]
		}
		if err := rows.Scan(vals...); err != nil {
			return nil, err
		}
		m := make(map[string]string, len(cols))
		for i, c := range cols {
			m[c] = ptrs[i].String
		}
		out = append(out, m)
	}
	return out, rows.Err()
}

// getDbSchema 复刻 schemaSync.js getDbSchema。
func getDbSchema(exec db.Commiter) (map[string]*dbTable, error) {
	tables, err := showTables(exec)
	if err != nil {
		return nil, err
	}
	schema := make(map[string]*dbTable, len(tables))
	for _, tableName := range tables {
		colRows, err := queryRows(exec, "SHOW FULL COLUMNS FROM "+quoteId(tableName))
		if err != nil {
			return nil, err
		}
		t := &dbTable{}
		for i, c := range colRows {
			var def *string
			if c["Default"] != "" {
				d := c["Default"]
				def = &d
			}
			t.Columns = append(t.Columns, dbColumn{
				Name:     c["Field"],
				Type:     c["Type"],
				Nullable: c["Null"] == "YES",
				Default:  def,
				Extra:    normalizeExtra(c["Extra"]),
				Comment:  c["Comment"],
				Position: i + 1,
			})
		}

		idxRows, err := queryRows(exec, "SHOW INDEX FROM "+quoteId(tableName))
		if err != nil {
			return nil, err
		}
		var indexes []dbIndex
		seen := map[string]bool{}
		for _, idx := range idxRows {
			if idx["Key_name"] == "PRIMARY" {
				continue
			}
			if seen[idx["Key_name"]] {
				continue
			}
			seen[idx["Key_name"]] = true
			var sameIdx []map[string]string
			for _, i2 := range idxRows {
				if i2["Key_name"] == idx["Key_name"] {
					sameIdx = append(sameIdx, i2)
				}
			}
			sort.SliceStable(sameIdx, func(a, b int) bool {
				na, _ := strconv.Atoi(sameIdx[a]["Seq_in_index"])
				nb, _ := strconv.Atoi(sameIdx[b]["Seq_in_index"])
				return na < nb
			})
			columnNames := make([]string, len(sameIdx))
			for i, c := range sameIdx {
				columnNames[i] = c["Column_name"]
			}
			indexes = append(indexes, dbIndex{
				Name:    idx["Key_name"],
				Columns: columnNames,
				Unique:  idx["Non_unique"] == "0",
			})
		}
		t.Indexes = indexes
		schema[tableName] = t
	}
	return schema, nil
}

// syncResult 对应 syncSchema 的返回 { creates, alters, drops, warnings }。
type syncResult struct {
	Creates  int
	Alters   int
	Drops    int
	Warnings []string
}

// isIgnorableAlterErr 对应 Node 忽略的 ER_DUP_FIELDNAME/ER_DUP_KEYNAME/
// ER_CANT_DROP_FIELD_OR_KEY/ER_BAD_FIELD_ERROR（字符串匹配等价）。
func isIgnorableAlterErr(err error) bool {
	if err == nil {
		return false
	}
	msg := err.Error()
	return strings.Contains(msg, "Duplicate column name") ||
		strings.Contains(msg, "Duplicate key name") ||
		strings.Contains(msg, "Can't DROP") ||
		strings.Contains(msg, "Unknown column")
}

// syncSchema 复刻 schemaSync.js syncSchema：全量同步（补列/删列/改类型/索引/表）。
func syncSchema(exec db.Commiter) (*syncResult, error) {
	targetPath := mysqlFilePath("live.sql")
	if targetPath == "" {
		targetPath = config.PathUnder(filepath.Join("../api/mysql", "live.sql"))
	}
	fmt.Printf("\n🔍 正在分析 %s ...\n", targetPath)
	target, err := parseLiveSQLFile()
	if err != nil {
		return nil, err
	}
	fmt.Printf("   目标表: %d 张\n", len(target.Tables))

	// 🔒 2026-10-13 修复（api.md P3-1）：空 target 熔断。
	//    parseLiveSql 的正则只认 `CREATE TABLE IF NOT EXISTS` 写法；若 live.sql
	//    改写/编码变化导致解析为 0 张表，下方"删表（DB 有，SQL 无）"逻辑会把
	//    全库非 _ 前缀表全部 DROP（数据灾难）。此处 target 为空即抛错中止。
	if len(target.Tables) == 0 {
		return nil, fmt.Errorf("[schemaSync 中止] %s 未解析出任何目标表（正则仅匹配 CREATE TABLE IF NOT EXISTS）。"+
			"若带着空的 target 继续同步会把数据库中全部业务表 DROP 掉，已中止。请检查 live.sql 文件内容。", targetPath)
	}

	actual, err := getDbSchema(exec)
	if err != nil {
		return nil, err
	}
	fmt.Printf("   实际表: %d 张\n", len(actual))

	result := &syncResult{}
	actualNames := make([]string, 0, len(actual))
	for name := range actual {
		actualNames = append(actualNames, name)
	}
	sort.Strings(actualNames)

	if _, err := exec.Exec("SET FOREIGN_KEY_CHECKS = 0"); err != nil {
		return nil, err
	}

	// 先把所有已有表转为 ROW_FORMAT=DYNAMIC（MySQL 5.7 COMPACT 行格式下索引键最大 767 字节，
	// DYNAMIC 提升到 3072 字节，避免 varchar(255) + utf8mb4 的索引超限）
	for _, tableName := range actualNames {
		if strings.HasPrefix(tableName, "_") {
			continue // 系统表跳过
		}
		rows, qerr := queryRows(exec, fmt.Sprintf("SHOW TABLE STATUS LIKE '%s'", tableName))
		if qerr != nil {
			fmt.Printf("  ⚠ 检查/修改 %s ROW_FORMAT 失败: %s\n", tableName, qerr.Error())
			continue
		}
		rowFormat := ""
		if len(rows) > 0 {
			rowFormat = rows[0]["Row_format"]
		}
		if !strings.EqualFold(rowFormat, "dynamic") {
			fmt.Printf("  🔧 %s ROW_FORMAT=%s → DYNAMIC\n", tableName, rowFormat)
			if _, err := exec.Exec("ALTER TABLE " + quoteId(tableName) + " ROW_FORMAT=DYNAMIC"); err != nil {
				fmt.Printf("  ⚠ 检查/修改 %s ROW_FORMAT 失败: %s\n", tableName, err.Error())
			}
		}
	}

	for _, tableName := range target.Order {
		targetDef := target.Tables[tableName]
		actualTable := actual[tableName]

		// 表不存在 → 从 live.sql 补建表
		if actualTable == nil {
			fmt.Printf("  🧱 %s 缺失，按 live.sql 创建\n", tableName)
			if _, err := exec.Exec(targetDef.CreateSQL); err != nil {
				return nil, err
			}
			result.Creates++
			continue
		}

		targetColMap := make(map[string]*liveColumn, len(targetDef.Columns))
		for i := range targetDef.Columns {
			targetColMap[targetDef.Columns[i].Name] = &targetDef.Columns[i]
		}
		actualColMap := make(map[string]*dbColumn, len(actualTable.Columns))
		for i := range actualTable.Columns {
			actualColMap[actualTable.Columns[i].Name] = &actualTable.Columns[i]
		}

		var altersSQL []string

		// 1. 补列 / 改类型（SQL 有，DB 可能无或类型不同）
		for i := range targetDef.Columns {
			col := &targetDef.Columns[i]
			actualCol := actualColMap[col.Name]
			if actualCol == nil {
				// 新增列
				altersSQL = append(altersSQL, "ADD COLUMN "+col.Definition)
				// 放在正确的 position
				if col.Position > 1 {
					prevCol := &targetDef.Columns[col.Position-2] // 前一个目标列
					if prevCol != nil {
						altersSQL[len(altersSQL)-1] += " AFTER " + quoteId(prevCol.Name)
					}
				} else {
					altersSQL[len(altersSQL)-1] += " FIRST"
				}
			} else if normalizeType(col.Type) != normalizeType(actualCol.Type) ||
				col.Nullable != actualCol.Nullable ||
				normalizeDefault(col.DefaultValue) != normalizeDefault(actualCol.Default) ||
				normalizeExtra(col.Extra) != normalizeExtra(actualCol.Extra) {
				// 类型不一致
				altersSQL = append(altersSQL, "MODIFY COLUMN "+col.Definition)
			}
		}

		// 2. 删列（DB 有，SQL 无）
		for i := range actualTable.Columns {
			col := &actualTable.Columns[i]
			if _, ok := targetColMap[col.Name]; !ok {
				altersSQL = append(altersSQL, "DROP COLUMN "+quoteId(col.Name))
				result.Warnings = append(result.Warnings, fmt.Sprintf("⚠ %s.%s → 将删除，数据丢失", tableName, col.Name))
			}
		}

		// 3. 同步索引
		actualIdxMap := make(map[string]*dbIndex, len(actualTable.Indexes))
		for i := range actualTable.Indexes {
			actualIdxMap[actualTable.Indexes[i].Name] = &actualTable.Indexes[i]
		}
		targetIdxMap := make(map[string]*liveIndex, len(targetDef.Indexes))
		for i := range targetDef.Indexes {
			targetIdxMap[targetDef.Indexes[i].Name] = &targetDef.Indexes[i]
		}

		for i := range targetDef.Indexes {
			idx := &targetDef.Indexes[i]
			actualIdx := actualIdxMap[idx.Name]
			sameColumns := actualIdx != nil && strings.Join(actualIdx.Columns, ",") == strings.Join(idx.Columns, ",")
			sameUnique := actualIdx != nil && actualIdx.Unique == idx.Unique

			if actualIdx == nil {
				altersSQL = append(altersSQL, "ADD "+idx.Definition)
			} else if !sameColumns || !sameUnique {
				altersSQL = append(altersSQL, "DROP INDEX "+quoteId(idx.Name))
				altersSQL = append(altersSQL, "ADD "+idx.Definition)
			}
		}

		for i := range actualTable.Indexes {
			idx := &actualTable.Indexes[i]
			if _, ok := targetIdxMap[idx.Name]; !ok {
				altersSQL = append(altersSQL, "DROP INDEX "+quoteId(idx.Name))
			}
		}

		// 执行
		if len(altersSQL) > 0 {
			fmt.Printf("  🔧 %s (%d 处差异)\n", tableName, len(altersSQL))
			for _, stmt := range altersSQL {
				if _, err := exec.Exec("ALTER TABLE " + quoteId(tableName) + " " + stmt); err != nil {
					if isIgnorableAlterErr(err) {
						fmt.Printf("     ⚠ 跳过: %s\n", prefixRunes(stmt, 60))
					} else {
						return nil, err
					}
				} else {
					fmt.Printf("     ✓ %s\n", prefixRunes(stmt, 80))
					result.Alters++
				}
			}
		}
	}

	// 删表（DB 有，SQL 无）
	for _, tableName := range actualNames {
		if strings.HasPrefix(tableName, "_") {
			continue // 系统表保护
		}
		if _, ok := target.Tables[tableName]; !ok {
			fmt.Printf("  🗑️ %s 在 live.sql 中不存在，删除旧表\n", tableName)
			if _, err := exec.Exec("DROP TABLE IF EXISTS " + quoteId(tableName)); err != nil {
				return nil, err
			}
			result.Drops++
			result.Warnings = append(result.Warnings, fmt.Sprintf("⚠ 表 %s 已删除；原数据只保留在本次备份中", tableName))
		}
	}

	if _, err := exec.Exec("SET FOREIGN_KEY_CHECKS = 1"); err != nil {
		return nil, err
	}

	fmt.Printf("\n  ✅ 同步完成: %d 张表创建，%d 个 ALTER 执行，%d 张旧表删除\n", result.Creates, result.Alters, result.Drops)
	if len(result.Warnings) > 0 {
		fmt.Printf("  ⚠ %d 条警告:\n", len(result.Warnings))
		for _, w := range result.Warnings {
			fmt.Printf("     %s\n", w)
		}
	}
	return result, nil
}

// ensureResult 对应 ensureMissingTables 的返回。
type ensureResult struct {
	Created int
	Missing []string
}

// ensureMissingTables 复刻 schemaSync.js ensureMissingTables：最小补建缺失表。
func ensureMissingTables(exec db.Commiter) (*ensureResult, error) {
	target, err := parseLiveSQLFile()
	if err != nil {
		return nil, err
	}
	tables, err := showTables(exec)
	if err != nil {
		return nil, err
	}
	existing := make(map[string]bool, len(tables))
	for _, t := range tables {
		existing[t] = true
	}

	var missing []string
	for _, t := range target.Order {
		if !existing[t] {
			missing = append(missing, t)
		}
	}
	if len(missing) == 0 {
		fmt.Println("  ✅ 数据库表结构完整，无需补表")
		return &ensureResult{0, nil}, nil
	}

	fmt.Printf("  ⚠ 检测数据库不完整，数据库缺少 %d 张表\n", len(missing))
	fmt.Println("  🔧 执行补表操作...")
	for _, tableName := range missing {
		def := target.Tables[tableName]
		if _, err := exec.Exec(def.CreateSQL); err != nil {
			fmt.Printf("     ✗ %s: %s\n", tableName, err.Error())
			return nil, err
		}
		fmt.Printf("     ✓ %s\n", tableName)
	}

	fmt.Printf("  ✅ 补表完成，补充 %d 张表\n", len(missing))
	return &ensureResult{len(missing), missing}, nil
}
