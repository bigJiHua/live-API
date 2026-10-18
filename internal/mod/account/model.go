package account

import (
	"encoding/json"
	"math"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"

	"live/api/internal/db"
	"live/api/internal/tim"
)

// ============================================================================
// 公共助手：行扫描（对齐 mysql2/Node 的类型口径）与 JS 数值语义
// ============================================================================

// queryRows 执行查询并转为行数组。列类型对齐 mysql2/Node 语义：
// DECIMAL → 字符串（mysql2 decimalNumbers=false 默认）、整型/浮点 → 数值、
// NULL → nil、DATETIME → "YYYY-MM-DD HH:mm:ss"。
func queryRows(ex db.Committer, query string, args ...any) ([]map[string]any, error) {
	rows, err := ex.Query(query, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	cts, err := rows.ColumnTypes()
	if err != nil {
		return nil, err
	}
	out := make([]map[string]any, 0)
	for rows.Next() {
		dst := make([]any, len(cts))
		for i := range dst {
			dst[i] = new(any)
		}
		if err := rows.Scan(dst...); err != nil {
			return nil, err
		}
		m := make(map[string]any, len(cts))
		for i, ct := range cts {
			m[ct.Name()] = normalizeCol(*(dst[i].(*any)), ct.DatabaseTypeName())
		}
		out = append(out, m)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return out, nil
}

// queryRow 取首行；无行返回 (nil, nil)，对应 Node rows[0] || null。
func queryRow(ex db.Commiter, query string, args ...any) (map[string]any, error) {
	rows, err := queryRows(ex, query, args...)
	if err != nil {
		return nil, err
	}
	if len(rows) == 0 {
		return nil, nil
	}
	return rows[0], nil
}

// execAffected 执行写语句并返回 affectedRows。
func execAffected(ex db.Commiter, query string, args ...any) (int64, error) {
	res, err := ex.Exec(query, args...)
	if err != nil {
		return 0, err
	}
	return res.RowsAffected()
}

// normalizeCol 把驱动返回值规范为 Node/mysql2 等价 JSON 语义。
func normalizeCol(v any, dbType string) any {
	switch t := v.(type) {
	case nil:
		return nil
	case []byte:
		s := string(t)
		switch strings.ToUpper(dbType) {
		case "DECIMAL", "NEWDECIMAL":
			return s // mysql2 默认 decimalNumbers=false：DECIMAL 原样字符串
		}
		if isNumericCol(dbType) {
			if f, err := strconv.ParseFloat(s, 64); err == nil {
				return f
			}
		}
		return s
	case time.Time:
		return t.In(tim.Loc()).Format("2006-01-02 15:04:05")
	default:
		return v
	}
}

func isNumericCol(dbType string) bool {
	switch strings.ToUpper(dbType) {
	case "TINYINT", "SMALLINT", "MEDIUMINT", "INT", "INTEGER", "BIGINT",
		"UNSIGNED TINYINT", "UNSIGNED SMALLINT", "UNSIGNED MEDIUMINT",
		"UNSIGNED INT", "UNSIGNED INTEGER", "UNSIGNED BIGINT",
		"FLOAT", "DOUBLE", "YEAR":
		return true
	}
	return false
}

// toF 复刻 parseFloat(x) || 0（DB/body 出的干净数值串；不可解析→0）。
func toF(v any) float64 {
	switch t := v.(type) {
	case nil:
		return 0
	case float64:
		return t
	case int64:
		return float64(t)
	case int:
		return float64(t)
	case json.Number:
		f, err := t.Float64()
		if err != nil {
			return 0
		}
		return f
	case string:
		f, err := strconv.ParseFloat(strings.TrimSpace(t), 64)
		if err != nil {
			return 0
		}
		return f
	case bool:
		if t {
			return 1
		}
		return 0
	}
	return 0
}

// toStr 复刻 JS String(v)（nil→""，float 整数不带小数点，bool→true/false）。
func toStr(v any) string {
	switch t := v.(type) {
	case nil:
		return ""
	case string:
		return t
	case []byte:
		return string(t)
	case json.Number:
		return t.String()
	case float64:
		return jsNumString(t)
	case int64:
		return strconv.FormatInt(t, 10)
	case int:
		return strconv.Itoa(t)
	case bool:
		if t {
			return "true"
		}
		return "false"
	}
	return ""
}

// jsNumString 复刻 JS String(number)：NaN→"NaN"，整数不带小数点。
func jsNumString(f float64) string {
	if math.IsNaN(f) {
		return "NaN"
	}
	if f == math.Trunc(f) && math.Abs(f) < 1e21 {
		return strconv.FormatInt(int64(f), 10)
	}
	return strconv.FormatFloat(f, 'f', -1, 64)
}

// jsToFixed2 复刻 Number(x).toFixed(2)（ties 远离零取整方向，-0 归一）。
func jsToFixed2(x float64) string {
	r := math.Round(x*100) / 100
	if r == 0 {
		r = 0
	}
	return strconv.FormatFloat(r, 'f', 2, 64)
}

// nanOrNil NaN → nil（对应 JS JSON 序列化 NaN→null）。
func nanOrNil(f float64) any {
	if math.IsNaN(f) {
		return nil
	}
	return f
}

// numParam 数值 SQL 参数：NaN → "NaN" 字符串（与 Node mysql2 发送 NaN 同样触发 SQL 错误路径）。
func numParam(f float64) any {
	if math.IsNaN(f) {
		return "NaN"
	}
	if f == math.Trunc(f) && math.Abs(f) < 1e15 {
		return int64(f)
	}
	return f
}

// jsParseIntQuery 复刻 parseInt(str)：宽松前缀解析，失败返回 NaN。
func jsParseIntQuery(s string) float64 {
	s = strings.TrimSpace(s)
	end, seenDigit := 0, false
loop:
	for i := 0; i < len(s); i++ {
		c := s[i]
		switch {
		case c >= '0' && c <= '9':
			seenDigit = true
			end = i + 1
		case (c == '-' || c == '+') && i == 0:
		default:
			break loop
		}
	}
	if !seenDigit {
		return math.NaN()
	}
	f, err := strconv.ParseFloat(s[:end], 64)
	if err != nil {
		return math.NaN()
	}
	return f
}

// orStr 对应 Node `x || def` 空串兜底。
func orStr(s, def string) string {
	if s == "" {
		return def
	}
	return s
}

// orDefault 对应 query 默认值：键存在（即使空串）用原值，否则默认（Node 解构默认值仅对 undefined 生效）。
func orDefault(q map[string][]string, key, def string) string {
	if v, ok := q[key]; ok && len(v) > 0 {
		return v[0]
	}
	return def
}

// hasQuery 判断 query 键是否存在（Node req.query.x !== undefined 语义）。
func hasQuery(q map[string][]string, key string) bool {
	_, ok := q[key]
	return ok
}

// AutoSaveSnapshotHook 资产快照钩子：对应 Node AssetSnapshot.autoSaveSnapshot(userId)，
// 由 asset 模块 init() 赋值（依赖方向 asset → account，避免循环）。
var AutoSaveSnapshotHook func(userID string)

// autoSaveSnapshot 复刻 setImmediate(autoSaveSnapshot)：异步执行 + panic 兜底。
func autoSaveSnapshot(userID string) {
	go func() {
		defer func() { _ = recover() }()
		if AutoSaveSnapshotHook != nil {
			AutoSaveSnapshotHook(userID)
		}
	}()
}

// ============================================================================
// 账务流水模型（公共只读层）—— from: model/index.js
// ============================================================================

const tableAccount = "account"

// listFilters 收支列表过滤条件。
type listFilters struct {
	directionSet bool
	direction    float64 // NaN = parseInt 失败（Node 侧原样透传 NaN）
	categoryID   string
	payMethod    string
	startDate    string
	endDate      string
}

// findAll 获取收支列表（支持分页和过滤）。
// from: model/index.js:22-72
func findAll(userID string, f listFilters, page, limit float64) (rows []map[string]any, total float64, err error) {
	offset := (page - 1) * limit
	whereClause := "WHERE a.user_id = ? AND a.is_deleted = 0"
	params := []any{userID}

	if f.directionSet {
		whereClause += " AND a.direction = ?"
		params = append(params, numParam(f.direction))
	}
	if f.categoryID != "" {
		whereClause += " AND a.category_id = ?"
		params = append(params, f.categoryID)
	}
	if f.payMethod != "" {
		whereClause += " AND a.pay_method = ?"
		params = append(params, f.payMethod)
	}
	if f.startDate != "" {
		whereClause += " AND a.trans_date >= ?"
		params = append(params, f.startDate)
	}
	if f.endDate != "" {
		whereClause += " AND a.trans_date <= ?"
		params = append(params, f.endDate)
	}

	countRows, err := queryRows(db.DB(),
		"SELECT COUNT(*) as total FROM "+tableAccount+" a "+whereClause, params...)
	if err != nil {
		return nil, 0, err
	}
	total = toF(countRows[0]["total"])

	query := `
      SELECT 
        a.id, a.user_id, a.direction, a.category_id,
        a.pay_type, a.pay_method, a.account_type, a.amount, a.currency, a.exchange_rate,
        a.trans_date, a.remark, a.card_id, a.create_time, a.update_time, a.reversed_id, a.transfer_group_id,
        c.name as category_name,
        cb.alias as card_alias,
        cb.last4_no as card_last4
      FROM ` + tableAccount + ` a
      LEFT JOIN bus_category c ON a.category_id = c.id
      LEFT JOIN card_base cb ON a.card_id = cb.id
      ` + whereClause + `
      ORDER BY a.trans_date DESC, a.create_time DESC
      LIMIT ? OFFSET ?
    `
	rows, err = queryRows(db.DB(), query, append(params, numParam(limit), numParam(offset))...)
	if err != nil {
		return nil, 0, err
	}
	return rows, total, nil
}

// FindById 根据ID查找单条记录（导出行，供 card/recurring 等模块调用）。
// from: model/index.js:77-95
func FindById(ex db.Commiter, id, userID string) (map[string]any, error) {
	query := `
      SELECT 
        a.id, a.user_id, a.direction, a.category_id,
        a.pay_type, a.pay_method, a.account_type, a.amount, a.currency, a.exchange_rate,
        a.trans_date, a.remark, a.card_id, a.create_time, a.update_time, a.reversed_id, a.transfer_group_id,
        c.name as category_name,
        cb.alias as card_alias,
        cb.last4_no as card_last4,
        rb.remark as reversed_remark
      FROM ` + tableAccount + ` a
      LEFT JOIN bus_category c ON a.category_id = c.id
      LEFT JOIN card_base cb ON a.card_id = cb.id
      LEFT JOIN ` + tableAccount + ` rb ON a.reversed_id = rb.id
      WHERE a.id = ? AND a.user_id = ? AND a.is_deleted = 0
    `
	return queryRow(ex, query, id, userID)
}

// findByCardID 根据卡片ID获取收支流水（默认本月）。
// from: model/index.js:100-152
func findByCardID(cardID, userID string, f listFilters, page, limit float64) (rows []map[string]any, total float64, err error) {
	offset := (page - 1) * limit
	whereClause := "WHERE a.card_id = ? AND a.user_id = ? AND a.is_deleted = 0"
	params := []any{cardID, userID}

	if f.directionSet {
		whereClause += " AND a.direction = ?"
		params = append(params, numParam(f.direction))
	}

	startDate, endDate := f.startDate, f.endDate
	if startDate == "" && endDate == "" {
		now := tim.Now()
		startDate = padDate(now.Year(), int(now.Month()), 1)
		endDate = padDate(now.Year(), int(now.Month()), daysInMonth(now.Year(), int(now.Month())))
	}
	if startDate != "" {
		whereClause += " AND a.trans_date >= ?"
		params = append(params, startDate)
	}
	if endDate != "" {
		whereClause += " AND a.trans_date <= ?"
		params = append(params, endDate)
	}

	countRows, err := queryRows(db.DB(),
		"SELECT COUNT(*) as total FROM "+tableAccount+" a "+whereClause, params...)
	if err != nil {
		return nil, 0, err
	}
	total = toF(countRows[0]["total"])

	query := `
      SELECT 
        a.id, a.user_id, a.direction, a.category_id,
        a.pay_type, a.pay_method, a.account_type, a.amount, a.currency, a.exchange_rate,
        a.trans_date, a.remark, a.card_id, a.create_time, a.update_time, a.reversed_id, a.transfer_group_id,
        c.name as category_name,
        cb.alias as card_alias,
        cb.last4_no as card_last4
      FROM ` + tableAccount + ` a
      LEFT JOIN bus_category c ON a.category_id = c.id
      LEFT JOIN card_base cb ON a.card_id = cb.id
      ` + whereClause + `
      ORDER BY a.trans_date DESC, a.create_time DESC
      LIMIT ? OFFSET ?
    `
	rows, err = queryRows(db.DB(), query, append(params, numParam(limit), numParam(offset))...)
	if err != nil {
		return nil, 0, err
	}
	return rows, total, nil
}

func padDate(year, month, day int) string {
	return strconv.Itoa(year) + "-" + pad2(month) + "-" + pad2(day)
}

func pad2(n int) string {
	if n < 10 {
		return "0" + strconv.Itoa(n)
	}
	return strconv.Itoa(n)
}

// daysInMonth 复刻 new Date(year, month+1, 0).getDate()。
func daysInMonth(year, month int) int {
	return time.Date(year, time.Month(month)+1, 0, 0, 0, 0, 0, time.UTC).Day()
}

// updateRemark 仅修改备注。
// from: model/index.js:169-185
func updateRemark(id, userID string, remark any) (map[string]any, error) {
	now := tim.NowMS()
	affected, err := execAffected(db.DB(), `
      UPDATE `+tableAccount+`
      SET remark = ?, update_time = ?
      WHERE id = ? AND user_id = ? AND is_deleted = 0
    `, remark, now, id, userID)
	if err != nil {
		return nil, err
	}
	if affected == 0 {
		return nil, nil
	}
	return FindById(db.DB(), id, userID)
}

// findByTransferGroup 根据 transfer_group_id 查找同组转账记录。
// from: model/index.js:198-210
func findByTransferGroup(transferGroupID, userID string) ([]map[string]any, error) {
	query := `
      SELECT 
        a.id, a.user_id, a.direction, a.category_id,
        a.pay_type, a.pay_method, a.account_type, a.amount, a.currency, a.exchange_rate,
        a.trans_date, a.remark, a.card_id, a.create_time, a.update_time, a.reversed_id, a.transfer_group_id
      FROM ` + tableAccount + ` a
      WHERE a.transfer_group_id = ? AND a.user_id = ? AND a.is_deleted = 0
      ORDER BY a.direction ASC
    `
	return queryRows(db.DB(), query, transferGroupID, userID)
}

// getTransferList 获取转账明细列表（含自动同步）。
// from: model/index.js:215-360
func getTransferList(userID string, page, limit float64, yearMonth string) (list []map[string]any, total float64, err error) {
	now := tim.NowMS()

	// 1. 查出所有未配对的转账记录（无 transfer_group_id），不限量自动配对
	unpairedRows, err := queryRows(db.DB(), `
      SELECT id, card_id, direction, amount, trans_date, remark
      FROM `+tableAccount+`
      WHERE user_id = ? AND is_deleted = 0 AND pay_type = '转账' AND transfer_group_id IS NULL
      ORDER BY create_time DESC
    `, userID)
	if err != nil {
		return nil, 0, err
	}

	// pairMap：key = `${Number(amount).toFixed(2)}_${trans_date}`（保持插入序）
	pairMap := map[string][]map[string]any{}
	keyOrder := []string{}
	for _, row := range unpairedRows {
		key := jsToFixed2(toF(row["amount"])) + "_" + toStr(row["trans_date"])
		if _, ok := pairMap[key]; !ok {
			keyOrder = append(keyOrder, key)
		}
		pairMap[key] = append(pairMap[key], row)
	}

	for _, key := range keyOrder {
		group := pairMap[key]
		var expenses, incomes []map[string]any
		for _, r := range group {
			if toF(r["direction"]) == 0 {
				expenses = append(expenses, r)
			} else {
				incomes = append(incomes, r)
			}
		}
		// 歧义配对跳过（与 Node 一致：console.warn 后 continue）
		if len(expenses) != 1 || len(incomes) != 1 {
			continue
		}
		expense, income := expenses[0], incomes[0]
		if toStr(expense["card_id"]) == toStr(income["card_id"]) {
			continue
		}
		groupID := toStr(expense["id"])
		_, _ = execAffected(db.DB(),
			`UPDATE `+tableAccount+` SET transfer_group_id = ? WHERE id IN (?, ?) AND user_id = ?`,
			groupID, toStr(expense["id"]), toStr(income["id"]), userID)
		// 配对写入失败仅告警（Node try/catch console.warn，不阻断）
		_, _ = execAffected(db.DB(), `
            INSERT INTO account_transfer (id, user_id, from_card_id, to_card_id, amount, trans_date, remark, create_time, is_deleted)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0)
            ON DUPLICATE KEY UPDATE is_deleted = 0, from_card_id = VALUES(from_card_id), to_card_id = VALUES(to_card_id)
          `,
			groupID, userID, toStr(expense["card_id"]), toStr(income["card_id"]),
			expense["amount"], expense["trans_date"], orStr(toStr(expense["remark"]), "转账"), now)
	}

	// 2. 处理已有 transfer_group_id 但未同步到 account_transfer 的记录
	groupedRows, err := queryRows(db.DB(), `
      SELECT DISTINCT transfer_group_id
      FROM `+tableAccount+`
      WHERE user_id = ? AND is_deleted = 0 AND pay_type = '转账' AND transfer_group_id IS NOT NULL
    `, userID)
	if err != nil {
		return nil, 0, err
	}
	allGroupIDs := make([]string, 0, len(groupedRows))
	for _, r := range groupedRows {
		allGroupIDs = append(allGroupIDs, toStr(r["transfer_group_id"]))
	}

	if len(allGroupIDs) > 0 {
		placeholders := strings.TrimSuffix(strings.Repeat("?,", len(allGroupIDs)), ",")
		args := make([]any, 0, len(allGroupIDs)+1)
		for _, g := range allGroupIDs {
			args = append(args, g)
		}
		args = append(args, userID)
		existingTransfers, err := queryRows(db.DB(),
			`SELECT id FROM account_transfer WHERE id IN (`+placeholders+`) AND user_id = ? AND is_deleted = 0`,
			args...)
		if err != nil {
			return nil, 0, err
		}
		existingIDs := map[string]bool{}
		for _, r := range existingTransfers {
			existingIDs[toStr(r["id"])] = true
		}

		for _, groupID := range allGroupIDs {
			if existingIDs[groupID] {
				continue
			}
			// keep BUG-021：反冲正检查恒不触发（reversed_id 在冲正子流水上，原流水被冲正后该列为空），维持原样
			reversedCheck, err := queryRows(db.DB(), `
              SELECT COUNT(*) as cnt FROM `+tableAccount+`
              WHERE transfer_group_id = ? AND user_id = ? AND is_deleted = 1 AND reversed_id IS NOT NULL
            `, groupID, userID)
			if err != nil {
				return nil, 0, err
			}
			if toF(reversedCheck[0]["cnt"]) > 0 {
				continue
			}
			pairRows, err := queryRows(db.DB(), `
              SELECT id, card_id, direction, amount, trans_date, remark FROM `+tableAccount+`
              WHERE transfer_group_id = ? AND user_id = ? AND is_deleted = 0
              ORDER BY direction ASC
            `, groupID, userID)
			if err != nil {
				return nil, 0, err
			}
			var expense, income map[string]any
			for _, r := range pairRows {
				if toF(r["direction"]) == 0 {
					expense = r
				} else {
					income = r
				}
			}
			if expense == nil || income == nil {
				continue
			}
			_, _ = execAffected(db.DB(), `
              INSERT INTO account_transfer (id, user_id, from_card_id, to_card_id, amount, trans_date, remark, create_time, is_deleted)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0)
              ON DUPLICATE KEY UPDATE is_deleted = 0, from_card_id = VALUES(from_card_id), to_card_id = VALUES(to_card_id)
            `,
				groupID, userID, toStr(expense["card_id"]), toStr(income["card_id"]),
				expense["amount"], expense["trans_date"], orStr(toStr(expense["remark"]), "转账"), now)
		}
	}

	// 3. 统计总数（从 account_transfer 表）
	countSQL := "SELECT COUNT(*) as total FROM account_transfer WHERE user_id = ? AND is_deleted = 0"
	countParams := []any{userID}
	if yearMonth != "" {
		countSQL += " AND (trans_date LIKE ? OR trans_date REGEXP ?)"
		countParams = append(countParams, yearMonth+"%", "^[0-9]+$")
	}
	countRows, err := queryRows(db.DB(), countSQL, countParams...)
	if err != nil {
		return nil, 0, err
	}
	total = toF(countRows[0]["total"])

	// 4. 分页获取最终数据
	offset := (page - 1) * limit
	listSQL := "SELECT * FROM account_transfer WHERE user_id = ? AND is_deleted = 0"
	listParams := []any{userID}
	if yearMonth != "" {
		listSQL += " AND (trans_date LIKE ? OR trans_date REGEXP ?)"
		listParams = append(listParams, yearMonth+"%", "^[0-9]+$")
	}
	listSQL += " ORDER BY trans_date DESC, create_time DESC LIMIT ? OFFSET ?"
	listParams = append(listParams, numParam(limit), numParam(offset))
	finalList, err := queryRows(db.DB(), listSQL, listParams...)
	if err != nil {
		return nil, 0, err
	}

	// 5. 标准化 trans_date：时间戳转 YYYY-MM-DD
	normalized := make([]map[string]any, 0, len(finalList))
	ymdRe := regexp.MustCompile(`^\d{4}-\d{2}-\d{2}`)
	for _, row := range finalList {
		td := toStr(row["trans_date"])
		if td != "" && !ymdRe.MatchString(td) {
			ts := toF(td)
			if !math.IsNaN(ts) && ts > 1000000000 {
				ms := ts * 1000
				if ts > 1000000000000 {
					ms = ts
				}
				d := time.UnixMilli(int64(ms)).In(tim.Loc())
				row["trans_date"] = padDate(d.Year(), int(d.Month()), d.Day())
			}
		}
		normalized = append(normalized, row)
	}
	return normalized, total, nil
}

// getMonthStats 获取本月收支统计。
// from: model/index.js:365-410
func getMonthStats(userID string, year, month int) (map[string]any, error) {
	startDate := padDate(year, month, 1)
	nextMonth, nextYear := month+1, year
	if month == 12 {
		nextMonth, nextYear = 1, year+1
	}
	endDate := padDate(nextYear, nextMonth, 1)

	// 查询时计算人民币价值：CNY 直接用，外币用 amount * exchange_rate / 100
	// 排除信用卡还款（CATEGORY_REPAY），因为它不算支出而是账单还款
	query := `
      SELECT 
        direction,
        SUM(CASE WHEN currency = 'CNY' THEN amount ELSE ROUND(amount * exchange_rate / 100, 2) END) as total,
        COUNT(*) as count
      FROM ` + tableAccount + `
      WHERE user_id = ? AND is_deleted = 0 
        AND trans_date >= ? AND trans_date < ?
        AND NOT (direction = 0 AND category_id = 'CATEGORY_REPAY')
      GROUP BY direction
    `
	rows, err := queryRows(db.DB(), query, userID, startDate, endDate)
	if err != nil {
		return nil, err
	}

	income, expense, incomeCount, expenseCount := 0.0, 0.0, 0.0, 0.0
	for _, row := range rows {
		if toF(row["direction"]) == 1 {
			income = toF(row["total"])
			incomeCount = toF(row["count"])
		} else if toF(row["direction"]) == 0 {
			expense = toF(row["total"])
			expenseCount = toF(row["count"])
		}
	}

	return map[string]any{
		"year":         year,
		"month":        month,
		"income":       income,
		"expense":      expense,
		"balance":      income - expense,
		"incomeCount":  incomeCount,
		"expenseCount": expenseCount,
	}, nil
}

// getStatsByCategory 按分类统计收支（人民币价值）。
// from: model/index.js:500-540
// keep BUG-020：不排除 CATEGORY_REPAY（与 getMonthStats 排除逻辑不一致），维持原样
func getStatsByCategory(userID string, year, month int) (income []map[string]any, expense []map[string]any, err error) {
	startDate := padDate(year, month, 1)
	nextMonth, nextYear := month+1, year
	if month == 12 {
		nextMonth, nextYear = 1, year+1
	}
	endDate := padDate(nextYear, nextMonth, 1)

	query := `
      SELECT 
        a.direction,
        a.category_id,
        c.name as category_name,
        SUM(CASE WHEN a.currency = 'CNY' THEN a.amount ELSE ROUND(a.amount * a.exchange_rate / 100, 2) END) as total,
        COUNT(*) as count
      FROM ` + tableAccount + ` a
      LEFT JOIN bus_category c ON a.category_id = c.id
      WHERE a.user_id = ? AND a.is_deleted = 0 
        AND a.trans_date >= ? AND a.trans_date < ?
      GROUP BY a.direction, a.category_id
      ORDER BY a.direction, total DESC
    `
	rows, err := queryRows(db.DB(), query, userID, startDate, endDate)
	if err != nil {
		return nil, nil, err
	}
	income = []map[string]any{}
	expense = []map[string]any{}
	for _, row := range rows {
		item := map[string]any{
			"categoryId":   toStr(row["category_id"]),
			"categoryName": orStr(toStr(row["category_name"]), "未分类"),
			"total":        toF(row["total"]),
			"count":        toF(row["count"]),
		}
		if toF(row["direction"]) == 1 {
			income = append(income, item)
		} else {
			expense = append(expense, item)
		}
	}
	return income, expense, nil
}

// getCardsFlowStats 获取所有银行卡近 N 个月「支出/收入笔数」（按卡聚合）。
// from: model/index.js:550-604
func getCardsFlowStats(userID string, months float64) (map[string]any, error) {
	cacheKey := userID + ":" + jsNumString(months)
	if cached, ok := flowStatsCacheGet(cacheKey); ok {
		return cached, nil
	}

	now := tim.Now()
	// 近 N 个月 = 本月 + 往前 (N-1) 个月，起始取该月 1 号，结束取今天（含）
	start := time.Date(now.Year(), now.Month()-time.Month(months-1), 1, 0, 0, 0, 0, tim.Loc())
	startDate := padDate(start.Year(), int(start.Month()), 1)
	endDate := padDate(now.Year(), int(now.Month()), now.Day())

	// 1. 取所有非虚拟银行卡 id（借记 + 信用），保证覆盖页面展示的每一张卡
	cards, err := queryRows(db.DB(),
		`SELECT id FROM card_base
       WHERE user_id = ? AND is_deleted = 0
         AND id NOT IN ('xxxx', 'yyyy')
         AND card_type IN ('debit', 'credit')`,
		userID)
	if err != nil {
		return nil, err
	}
	cardIDs := make([]string, 0, len(cards))
	for _, c := range cards {
		cardIDs = append(cardIDs, toStr(c["id"]))
	}

	// 2. 初始化结果，所有卡默认 0 0（保持卡片查询顺序）
	resultMap := map[string]map[string]any{}
	list := make([]map[string]any, 0, len(cardIDs))
	for _, id := range cardIDs {
		entry := map[string]any{"cardId": id, "expenseCount": 0.0, "incomeCount": 0.0}
		resultMap[id] = entry
		list = append(list, entry)
	}

	// 3. 按卡 + 方向聚合近 N 个月的笔数
	if len(cardIDs) > 0 {
		placeholders := strings.TrimSuffix(strings.Repeat("?,", len(cardIDs)), ",")
		args := []any{userID, startDate, endDate}
		for _, id := range cardIDs {
			args = append(args, id)
		}
		rows, err := queryRows(db.DB(), `
         SELECT card_id, direction, COUNT(*) as cnt
         FROM `+tableAccount+`
         WHERE user_id = ? AND is_deleted = 0
           AND trans_date >= ? AND trans_date <= ?
           AND card_id IN (`+placeholders+`)
         GROUP BY card_id, direction`, args...)
		if err != nil {
			return nil, err
		}
		for _, r := range rows {
			entry, ok := resultMap[toStr(r["card_id"])]
			if !ok {
				continue
			}
			if toF(r["direction"]) == 0 {
				entry["expenseCount"] = toF(r["cnt"])
			} else if toF(r["direction"]) == 1 {
				entry["incomeCount"] = toF(r["cnt"])
			}
		}
	}

	result := map[string]any{"start": startDate, "end": endDate, "list": list}
	flowStatsCacheSet(cacheKey, result)
	return result, nil
}

// ===== 近月收支笔数缓存（按用户隔离，TTL 60s）—— from: model/index.js:3-5 =====

const flowStatsCacheTTLMs = 60 * 1000

var (
	flowStatsMu    sync.Mutex
	flowStatsCache = map[string]struct {
		ts   int64
		data map[string]any
	}{}
)

func flowStatsCacheGet(key string) (map[string]any, bool) {
	flowStatsMu.Lock()
	defer flowStatsMu.Unlock()
	e, ok := flowStatsCache[key]
	if !ok {
		return nil, false
	}
	if tim.Now().UnixMilli()-e.ts >= flowStatsCacheTTLMs {
		delete(flowStatsCache, key)
		return nil, false
	}
	return e.data, true
}

func flowStatsCacheSet(key string, data map[string]any) {
	flowStatsMu.Lock()
	defer flowStatsMu.Unlock()
	flowStatsCache[key] = struct {
		ts   int64
		data map[string]any
	}{ts: tim.Now().UnixMilli(), data: data}
}
