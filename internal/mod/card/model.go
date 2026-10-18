// Package card 复刻 src/modules/card：卡片管理（card_base）、共享额度池（card_credit_pool）、
// 卡片操作日志（card_log）。SQL 逐字一致（? 占位）。
//
// 依赖方向（对应 Node import 关系）：
//   - card → category（model/index.js require ../../category/model/bank，initVirtualCards 建档虚拟银行）
//   - card → cardbill / creditcore（账单唯一真相源）
//   - card → account（repay 调 DebitAccountCreate / settlement）
package card

import (
	"encoding/json"
	"math"
	"strconv"
	"strings"
	"time"

	"live/api/internal/db"
	"live/api/internal/idgen"
	"live/api/internal/mod/cardbill"
	"live/api/internal/mod/category"
	"live/api/internal/mod/creditcore"
	"live/api/internal/tim"
)

// cardTable 对应 Card.tableName = 'card_base'。
const cardTable = "card_base"

// ===== 行 → map 工具（与 cardbill/creditcore 包各自的私有副本，避免共享导出面） =====

// qRow 查询单行并转为 map（列名 → 值）；无记录返回 nil, nil。
func qRow(ex db.Commiter, q string, args ...any) (map[string]any, error) {
	rows, err := ex.Query(q, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	cols, err := rows.Columns()
	if err != nil {
		return nil, err
	}
	if !rows.Next() {
		return nil, rows.Err()
	}
	vals := make([]any, len(cols))
	ptrs := make([]any, len(cols))
	for i := range vals {
		ptrs[i] = &vals[i]
	}
	if err := rows.Scan(ptrs...); err != nil {
		return nil, err
	}
	m := make(map[string]any, len(cols))
	for i, c := range cols {
		m[c] = normVal(vals[i])
	}
	return m, rows.Err()
}

// qRows 查询多行并转为 []map。
func qRows(ex db.Commiter, q string, args ...any) ([]map[string]any, error) {
	rows, err := ex.Query(q, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	cols, err := rows.Columns()
	if err != nil {
		return nil, err
	}
	out := []map[string]any{}
	for rows.Next() {
		vals := make([]any, len(cols))
		ptrs := make([]any, len(cols))
		for i := range vals {
			ptrs[i] = &vals[i]
		}
		if err := rows.Scan(ptrs...); err != nil {
			return nil, err
		}
		m := make(map[string]any, len(cols))
		for i, c := range cols {
			m[c] = normVal(vals[i])
		}
		out = append(out, m)
	}
	return out, rows.Err()
}

// normVal DB 值 → JSON 友好值：[]byte→string；time.Time→Node JSON.stringify(Date) 的 UTC ISO 串；其余原样。
func normVal(v any) any {
	switch t := v.(type) {
	case []byte:
		return string(t)
	case time.Time:
		return t.UTC().Format("2006-01-02T15:04:05.000Z")
	}
	return v
}

// ===== 通用值转换（对应 JS 松散语义） =====

// toStr 对应 String(v) 常用子集。
func toStr(v any) string {
	switch t := v.(type) {
	case nil:
		return ""
	case string:
		return t
	case float64:
		return strconv.FormatFloat(t, 'f', -1, 64)
	case int64:
		return strconv.FormatInt(t, 10)
	case bool:
		if t {
			return "true"
		}
		return "false"
	}
	return ""
}

// toF 对应 parseFloat(v) || 0：不可解析/空 → 0。
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
	case string:
		f, err := strconv.ParseFloat(strings.TrimSpace(t), 64)
		if err != nil {
			return 0
		}
		return f
	}
	return 0
}

// truthy 对应 JS 真值判断（非空字符串皆真，含 "false"）。
func truthy(v any) bool {
	switch t := v.(type) {
	case nil:
		return false
	case bool:
		return t
	case string:
		return t != ""
	case float64:
		return t != 0
	case int64:
		return t != 0
	case int:
		return t != 0
	case []any:
		return true
	case map[string]any:
		return true
	}
	return true
}

func b2i(v any) int {
	if truthy(v) {
		return 1
	}
	return 0
}

// jsNum 对应 Number(v)：解析失败/非数字 → NaN（ok=false）。
func jsNum(v any) (float64, bool) {
	switch t := v.(type) {
	case nil:
		return 0, true
	case float64:
		return t, true
	case int64:
		return float64(t), true
	case int:
		return float64(t), true
	case bool:
		if t {
			return 1, true
		}
		return 0, true
	case json.Number:
		f, err := t.Float64()
		if err != nil {
			return math.NaN(), false
		}
		return f, true
	case string:
		s := strings.TrimSpace(t)
		if s == "" {
			return 0, true // Number("") = 0
		}
		f, err := strconv.ParseFloat(s, 64)
		if err != nil {
			return math.NaN(), false
		}
		return f, true
	}
	return math.NaN(), false
}

// jsNumString 复刻 JS String(number)：整数不带小数点。
func jsNumString(f float64) string {
	if math.IsNaN(f) {
		return "NaN"
	}
	if f == math.Trunc(f) && math.Abs(f) < 1e21 {
		return strconv.FormatInt(int64(f), 10)
	}
	return strconv.FormatFloat(f, 'f', -1, 64)
}

// numEq 数值相等比较（不可解析按 0 口径；对应 JS 清洗后数字的 `!==` 比较）。
func numEq(a, b any) bool {
	fa, _ := jsNum(a)
	fb, _ := jsNum(b)
	return fa == fb
}

// sqlVal SQL 参数规整：json.Number → int64/float64（database/sql 不直接支持 json.Number）。
func sqlVal(v any) any {
	if n, ok := v.(json.Number); ok {
		if i, err := n.Int64(); err == nil {
			return i
		}
		if f, err := n.Float64(); err == nil {
			return f
		}
		return n.String()
	}
	return v
}

// ===== 卡片模型 - 对应数据库 card_base 表 =====

// virtualCard 对应 Card.VIRTUAL_CARDS 的条目（Object.entries 顺序：CASH → BALANCE）。
type virtualCard struct {
	key string // "CASH" / "BALANCE"
	id  string // "xxxx" / "yyyy"
}

var virtualCards = []virtualCard{{key: "CASH", id: "xxxx"}, {key: "BALANCE", id: "yyyy"}}

// initVirtualCards 对应 Card.initVirtualCards(userId)：
// 初始化虚拟账户（现金 xxxx / 余额 yyyy），不存在则建档（33 列 INSERT）。
// from: model/index.js:23-84
func initVirtualCards(userID string) ([]map[string]any, error) {
	now := tim.NowMS()
	results := []map[string]any{}

	// 1. 初始化虚拟银行分类到 bus_category 表（对应 Node require ../../category/model/bank）
	if _, err := category.InitVirtualBanks(userID); err != nil {
		return nil, err
	}

	// 2. 创建/更新虚拟卡片（只创建不存在的，不重复更新）
	for _, vt := range virtualCards {
		alias := "现金"
		cardType := "virtual_cash"
		if vt.key == "BALANCE" {
			alias = "余额"
			cardType = "virtual_balance"
		}
		bankID := vt.id

		// 检查是否已存在
		// fix BUG-032: 存在性查询补 is_deleted = 0。
		// Node 原为 `SELECT id, bank_id FROM card_base WHERE id = ? AND user_id = ?`（无 is_deleted）：
		// 虚拟卡被软删后永远命中已删行 → 不重建 → findAll（is_deleted=0）永远看不到 → 「删后无法恢复」。
		existing, err := qRow(db.DB(),
			"SELECT id, bank_id FROM card_base WHERE id = ? AND user_id = ? AND is_deleted = 0",
			bankID, userID)
		if err != nil {
			return nil, err
		}

		if existing == nil {
			// 创建新记录 - 所有字段都用占位符（33 列 INSERT，逐字复刻）
			// from: model/index.js:45-54
			if err := insertVirtualCard(bankID, userID, cardType, alias, now); err != nil {
				return nil, err
			}
		} else if toStr(existing["bank_id"]) != bankID {
			// 仅当 bank_id 不匹配时才更新（Node 原 SQL 不带 is_deleted，维持原样）
			if _, err := db.DB().Exec(
				"UPDATE card_base SET bank_id = ?, update_time = ? WHERE id = ? AND user_id = ?",
				bankID, now, bankID, userID); err != nil {
				return nil, err
			}
		}

		// 获取并返回虚拟账户信息（Node 原 SQL 不带 is_deleted，维持原样）
		row, err := qRow(db.DB(), "SELECT * FROM card_base WHERE id = ? AND user_id = ?", bankID, userID)
		if err != nil {
			return nil, err
		}
		if row != nil {
			results = append(results, row)
		}
	}

	return results, nil
}

// insertVirtualCard 建档虚拟卡（33 列 INSERT，逐字复刻 model/index.js:45-62）。
// fix BUG-032 续：软删的虚拟卡仍占主键，INSERT 撞 ER_DUP_ENTRY(1062) 时恢复该行（is_deleted=0），
// 即「虚拟卡删后恢复」；若不恢复，补了 is_deleted 过滤的存在性查询反而会让建档路径直接报错。
func insertVirtualCard(cardID, userID, cardType, alias, now string) error {
	query := `
          INSERT INTO card_base (
            id, user_id, bank_id, card_type, card_level, main_sub, card_org,
            card_length, last4_no, card_bin, credit_limit, temp_limit,
            alias, card_img, open_date, expire_date,
            bill_day, repay_day, currency, status, is_default, is_hide, sort,
            tag, remark, color, annual_fee, fee_free_rule, source_from,
            points_rate, create_time, update_time, is_deleted
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `
	_, err := db.DB().Exec(query, []any{
		cardID, userID, cardID, cardType, "000", "000", "000",
		"0", "0000", "000", 0, 0,
		alias, "", "0000-00-00", "0000-00-00",
		0, 0, "CNY", "正常", 0, 0, 99,
		"", "", "#999999", 0, "", "系统",
		1, now, now, 0,
	}...)
	if err != nil {
		// fix BUG-032：1062 = 软删虚拟卡占位 → 恢复（对应 api.logs「init 查询补 is_deleted」的修复目标）
		if isDupEntry(err) {
			if _, uerr := db.DB().Exec(
				"UPDATE card_base SET is_deleted = 0, update_time = ? WHERE id = ? AND user_id = ?",
				now, cardID, userID); uerr == nil {
				return nil
			}
		}
		return err
	}
	return nil
}

// cardFilters 对应 Node findAll(userId, filters)。
type cardFilters struct {
	cardType  string // 空 = 不过滤（Node `if (filters.cardType)` 真值判断）
	isHideSet bool   // Node `filters.isHide !== undefined`（存在即过滤，parseInt 后的值）
	isHide    int
}

// FindAll 对应 Card.findAll(userId, filters={cardType,isHide})：
// 三套 SELECT 列表（credit 完整字段 / debit 基础字段 / 默认=完整字段）。
// 银行名：LEFT JOIN bus_category(type='bank')，供前端 `alias || 银行名(尾号)` 兜底展示。
// from: model/index.js:90-153
func CardFindAll(userID string, f cardFilters) ([]map[string]any, error) {
	// 确保虚拟账户已初始化（Node findAll 前置副作用；creditcore 聚合路径不含，见其注释）
	if _, err := initVirtualCards(userID); err != nil {
		return nil, err
	}

	whereClause := "WHERE card_base.user_id = ? AND card_base.is_deleted = 0"
	params := []any{userID}

	if f.cardType != "" {
		whereClause += " AND card_base.card_type = ?"
		params = append(params, f.cardType)
	}
	if f.isHideSet {
		whereClause += " AND card_base.is_hide = ?"
		params = append(params, f.isHide)
	}

	const bankJoin = `LEFT JOIN bus_category b ON b.id = card_base.bank_id AND b.type = 'bank' AND b.is_deleted = 0`
	const bankSelect = `, b.name AS bank_name`

	var query string
	switch f.cardType {
	case "debit":
		// 借记卡：返回基础字段
		query = `
        SELECT card_base.id, card_base.user_id, card_base.bank_id, card_base.card_type, card_base.card_bin, card_base.card_length, card_base.last4_no, card_base.alias,
               card_base.open_date, card_base.expire_date, card_base.card_org, card_base.tag, card_base.card_img, card_base.color` + bankSelect + `
        FROM card_base
        ` + bankJoin + `
        ` + whereClause + `
        ORDER BY card_base.is_default DESC, card_base.sort ASC, card_base.create_time DESC
      `
	default:
		// 🔒 SYNC-A39：Node 是 if/else if/else 三分支 —— 只有**恰好** 'debit' 走基础字段，
		// 其余一切值（不筛选 / 'credit' / 'virtual_cash' / 任意脏值）都落 else 拿完整字段集。
		// 旧实现写成 `case "credit", "":` + default ⇒ 脏值被误判为借记卡，
		// 导致 credit_limit / temp_limit / bill_day / repay_day / points_rate / share_pool_id 全部缺失。
		query = `
        SELECT card_base.id, card_base.user_id, card_base.bank_id, card_base.card_type, card_base.card_bin, card_base.card_length, card_base.last4_no, card_base.alias,
               card_base.open_date, card_base.expire_date, card_base.card_org, card_base.tag, card_base.bill_day, card_base.repay_day,
               card_base.credit_limit, card_base.temp_limit, card_base.points_rate, card_base.share_pool_id,
               card_base.card_img, card_base.color` + bankSelect + `
        FROM card_base
        ` + bankJoin + `
        ` + whereClause + `
        ORDER BY card_base.is_default DESC, card_base.sort ASC, card_base.create_time DESC
      `
	}
	return qRows(db.DB(), query, params...)
}

// FindById 对应 Card.findById(id, userId)。
// from: model/index.js:158-162
func CardFindById(id, userID string) (map[string]any, error) {
	return qRow(db.DB(),
		"SELECT * FROM card_base WHERE id = ? AND user_id = ? AND is_deleted = 0",
		id, userID)
}

// CardCreateParams 卡片创建入参（d = Joi 清洗后的 req.body.data；nil = data 缺失）。
type CardCreateParams struct {
	UserID string
	Data   map[string]any
}

// Create 对应 Card.create（34 列 INSERT；卡片类型默认 debit，信用卡立即初始化当前月账单）。
// d 为清洗后的 data（Joi default 已预填）；d == nil 对应 Node `{...req.body.data}` 中 data 缺失，
// 此时全部走模型层 `||` 兜底默认值（与 Joi default 可能不同，如 cardLevel → ”）。
// from: model/index.js:167-267
func CreateCard(userID string, d map[string]any) (map[string]any, error) {
	id := idgen.BillID()
	now := tim.NowMS()

	// C6：sharePoolId 必须验证池归属，禁止绕过 CreditPool 管理链路直接写入不存在的池
	sharePoolID := strOrNil(d["sharePoolId"]) // Node `sharePoolId || null`
	if sharePoolID != nil {
		pool, err := poolFindById(toStr(sharePoolID), userID)
		if err != nil {
			return nil, err
		}
		if pool == nil {
			return nil, errText("共享池不存在")
		}
	}

	query := `
      INSERT INTO card_base (
        id, user_id, bank_id, card_type, card_level, main_sub, card_org,
        card_length, last4_no, card_bin, credit_limit, temp_limit,
        alias, card_img, open_date, expire_date,
        bill_day, repay_day, currency, status, is_default, is_hide, sort,
        tag, remark, color, annual_fee, fee_free_rule, source_from,
        share_pool_id, points_rate, create_time, update_time, is_deleted
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)
    `

	cardType := jstr(d, "cardType", "debit")
	_, err := db.DB().Exec(query, []any{
		id,
		userID,
		jstr(d, "bankId", ""),
		cardType,
		jstr(d, "cardLevel", "普卡"),
		jstr(d, "mainSub", "主卡"),
		jstr(d, "cardOrg", "银联"),
		jstr(d, "cardLength", "19"),
		jstr(d, "last4No", ""),
		jstr(d, "cardBin", ""),
		jnum(d, "creditLimit", 0),
		jnum(d, "tempLimit", 0),
		jstr(d, "alias", ""),
		jstr(d, "cardImg", ""),
		jstr(d, "openDate", ""),
		jstr(d, "expireDate", ""),
		jnum(d, "billDay", 0),
		jnum(d, "repayDay", 0),
		jstr(d, "currency", "CNY"),
		jstr(d, "status", "正常"),
		b2i(jbool(d, "isDefault")),
		b2i(jbool(d, "isHide")),
		jnum(d, "sort", 99),
		jstr(d, "tag", ""),
		jstr(d, "remark", ""),
		jstr(d, "color", "#0052cc"),
		jnum(d, "annualFee", 0),
		jstr(d, "feeFreeRule", ""),
		jstr(d, "sourceFrom", "手动"),
		sharePoolID,
		jnum(d, "pointsRate", 1),
		now,
		now,
	}...)
	if err != nil {
		return nil, err
	}

	// 信用卡：立即初始化当前月账单（Node try/catch 仅 console.error，维持原样）
	if cardType == "credit" {
		// billMonth 传 "" ⇒ 回退当前账单月（对齐 Node `billMonth || getCurrentBillMonth()`）
		if _, err := cardbill.GetOrCreateBill(db.DB(), id, userID, ""); err != nil {
			println("[初始化账单失败]", err.Error())
		}
	}

	return CardFindById(id, userID)
}

// Update 对应 Card.update（禁 credit⇄debit 互切；信用卡账单日/还款日 1-31 且变更需无流水/还款记录；
// sharePoolId 走 CreditPool.assignCard；改额度/账单单/还款日后 setImmediate 重算账单）。
// from: model/index.js:272-410
func UpdateCard(id, userID string, updates map[string]any) (map[string]any, error) {
	// Node `updates.cardType` 对 undefined 取值即抛 TypeError（req.body.data 缺失场景）→ controller 500
	if updates == nil {
		return nil, errText("Cannot read properties of undefined (reading 'cardType')")
	}

	// 获取原始卡片数据
	original, err := CardFindById(id, userID)
	if err != nil {
		return nil, err
	}

	// P1-3 审计：禁止 credit ⇄ debit 类型切换——切换会让历史流水被重新解读
	if original != nil && updates["cardType"] != nil &&
		toStr(updates["cardType"]) != toStr(original["card_type"]) {
		return nil, errText("不允许修改卡片类型（信用卡/借记卡不可互相切换）。如需变更，请删除卡片后重新创建")
	}

	// JS 严格 !== 比较（undefined 不参与；显式 null 视为变更——Number(null)=0）；
	// 清洗层已把数字串转数字，此处按 Node 语义按数值比较
	_, billDayPresent := updates["billDay"]
	_, repayDayPresent := updates["repayDay"]
	billDayChanged := billDayPresent && original != nil &&
		!numEq(updates["billDay"], original["bill_day"])
	repayDayChanged := repayDayPresent && original != nil &&
		!numEq(updates["repayDay"], original["repay_day"])
	isCreditCard := original != nil && toStr(original["card_type"]) == "credit"

	// R6：信用卡 billDay/repayDay 必须 1-31（null/0 会让 REPAY_DATE_SQL 与 #computeMonths 计算失效）
	if isCreditCard {
		if billDayPresent {
			bd, _ := jsNum(updates["billDay"]) // Number(null) = 0 → < 1 抛错（同 Node）
			if bd != math.Trunc(bd) || bd < 1 || bd > 31 {
				return nil, errText("信用卡账单日必须在 1-31 之间")
			}
		}
		if repayDayPresent {
			rd, _ := jsNum(updates["repayDay"])
			if rd != math.Trunc(rd) || rd < 1 || rd > 31 {
				return nil, errText("信用卡还款日必须在 1-31 之间")
			}
		}
	}

	// 信用卡修改账单日/还款日：检查是否是新卡
	if isCreditCard && (billDayChanged || repayDayChanged) {
		hasAccountRecords, err := hasAccountRecords(id, userID)
		if err != nil {
			return nil, err
		}
		hasRepayRecords, err := hasRepayRecords(id)
		if err != nil {
			return nil, err
		}
		if hasAccountRecords || hasRepayRecords {
			return nil, errText("该卡片已有收支记录或还款记录，不允许修改账单日/还款日。如需修改，请删除相关记录后重新创建卡片。")
		}
	}

	now := tim.NowMS()
	var fields []string
	var params []any

	fieldMap := []struct{ js, db string }{
		{"bankId", "bank_id"},
		{"cardType", "card_type"},
		{"cardLevel", "card_level"},
		{"mainSub", "main_sub"},
		{"cardOrg", "card_org"},
		{"cardLength", "card_length"},
		{"last4No", "last4_no"},
		{"cardBin", "card_bin"},
		{"alias", "alias"},
		{"cardImg", "card_img"},
		{"openDate", "open_date"},
		{"expireDate", "expire_date"},
		{"billDay", "bill_day"},
		{"repayDay", "repay_day"},
		{"currency", "currency"},
		{"status", "status"},
		{"isDefault", "is_default"},
		{"isHide", "is_hide"},
		{"sort", "sort"},
		{"tag", "tag"},
		{"remark", "remark"},
		{"color", "color"},
		{"annualFee", "annual_fee"},
		{"feeFreeRule", "fee_free_rule"},
		{"sourceFrom", "source_from"},
		{"creditLimit", "credit_limit"},
		{"tempLimit", "temp_limit"},
		{"pointsRate", "points_rate"},
		// C6：sharePoolId 不再在 fieldMap 中直写——必须走 CreditPool.assignCard
		//     （归属校验 + 两侧/全池重算），否则绕过共享池管理链路。
	}

	// C6：检测池变更（与原值不同才算），交由 CreditPool.assignCard 处理
	_, sharePoolPresent := updates["sharePoolId"]
	poolChange := sharePoolPresent && original != nil &&
		strOrNil(updates["sharePoolId"]) != strOrNil(original["share_pool_id"])

	for _, fm := range fieldMap {
		v, ok := updates[fm.js]
		if !ok {
			continue // Node 仅处理 updates 中已定义的键（undefined 跳过）
		}
		var value any = sqlVal(v)
		// 处理布尔值转 tinyint（Node `value ? 1 : 0`；清洗层已做 Joi boolean convert）
		if fm.js == "isDefault" || fm.js == "isHide" {
			value = b2i(v)
		}
		fields = append(fields, fm.db+" = ?")
		params = append(params, value)
	}

	if len(fields) == 0 && !poolChange {
		// 没有需要更新的字段
		return CardFindById(id, userID)
	}

	if len(fields) > 0 {
		fields = append(fields, "update_time = ?")
		params = append(params, now)
		params = append(params, id, userID)

		query := `
        UPDATE card_base
        SET ` + strings.Join(fields, ", ") + `
        WHERE id = ? AND user_id = ? AND is_deleted = 0
      `
		if _, err := db.DB().Exec(query, params...); err != nil {
			return nil, err
		}
	}

	// C6：池变更必须走 CreditPool.assignCard（归属校验 + 事务化更新 + 旧池/新池全池重算）
	if poolChange {
		newPoolID := ""
		if v := strOrNil(updates["sharePoolId"]); v != nil {
			newPoolID = toStr(v)
		}
		if err := poolAssignCard(id, userID, newPoolID); err != nil {
			return nil, err
		}
	}

	// 修改账单日/还款日/额度后，统一由 CreditCore 重算账单
	// （sharePoolId 变更已由 assignCard 完成全池重算，不在此重复触发）
	_, limitChanged := updates["creditLimit"]
	_, tempChanged := updates["tempLimit"]
	_, pointsChanged := updates["pointsRate"]
	if isCreditCard && (billDayChanged || repayDayChanged || limitChanged || tempChanged || pointsChanged) {
		// 对应 Node setImmediate(() => CreditCore.syncCardBills(id, userId).catch(...))
		go func() {
			defer func() { _ = recover() }()
			_ = creditcore.SyncCardBills(db.DB(), id, userID)
		}()
	}

	return CardFindById(id, userID)
}

// UpdateSortBatch 对应 Card.updateSortBatch(userId, items)：
// 前端整列 1-N 重排后一次提交，单事务内逐个 UPDATE。
// from: model/index.js:418-439
func CardUpdateSortBatch(userID string, items []any) error {
	if len(items) == 0 {
		return nil
	}
	tx, err := db.GetPool().Begin()
	if err != nil {
		return err
	}
	committed := false
	defer func() {
		if !committed {
			_ = tx.Rollback()
		}
	}()
	for _, it := range items {
		m, ok := it.(map[string]any)
		if !ok {
			continue // Node `if (!it || !it.id) continue`
		}
		itemID := toStr(m["id"])
		if itemID == "" {
			continue
		}
		// 🔒 SYNC-A39：必须先判**键是否存在**。Node 的 `Number(it.sort)` 在 sort 缺失时
		// 得 NaN（undefined→NaN）⇒ 跳过该条；但 Go 的 jsNum(nil) 返回 (0, true)
		// （它复刻的是 Number(null)===0）⇒ 旧实现会把 sort 覆盖成 0，
		// 让这张卡排到列表最前，而 Node 保持原值不动。
		rawSort, present := m["sort"]
		if !present {
			continue // Node: Number(undefined) = NaN ⇒ continue
		}
		sort, ok := jsNum(rawSort)
		if !ok || math.IsNaN(sort) || math.IsInf(sort, 0) {
			continue // Node `if (!Number.isFinite(sort)) continue`
		}
		if _, err := tx.Exec(
			"UPDATE card_base SET sort = ?, update_time = ? WHERE id = ? AND user_id = ? AND is_deleted = 0",
			sqlVal(sort), tim.NowMS(), itemID, userID); err != nil {
			return err
		}
	}
	if err := tx.Commit(); err != nil {
		return err
	}
	committed = true
	return nil
}

// DeleteCard 对应 Card.delete(id, userId)：
// 只删除 account_balance（余额数据无意义）+ 软删关联流水与卡片主表；
// 其他关联数据（账单/还款/日志）保留，查询时用 is_deleted=0 过滤。
// 🔒 2026-10-13（api.md P2-8）：三条 UPDATE 包事务——原先各自自动提交，
//
//	第二条（account）失败时 account_balance 已软删而卡片/流水未删，
//	数据不一致（实测触发器注入复现）。现任一失败整体回滚。
//
// from: model/index.js:457-491
func DeleteCard(id, userID string) (bool, error) {
	now := tim.NowMS()

	tx, err := db.GetPool().Begin()
	if err != nil {
		return false, err
	}
	committed := false
	defer func() {
		if !committed {
			_ = tx.Rollback()
		}
	}()

	// 1. 删除关联的账户余额
	if _, err := tx.Exec(
		"UPDATE account_balance SET is_deleted = 1, update_time = ? WHERE card_id = ? AND user_id = ?",
		now, id, userID); err != nil {
		return false, err
	}

	// 2. 删除关联的流水记录（可选，如需清理）
	if _, err := tx.Exec(
		"UPDATE account SET is_deleted = 1, update_time = ? WHERE card_id = ? AND user_id = ?",
		now, id, userID); err != nil {
		return false, err
	}

	// 3. 软删除卡片主表
	res, err := tx.Exec(
		"UPDATE card_base SET is_deleted = 1, update_time = ? WHERE id = ? AND user_id = ?",
		now, id, userID)
	if err != nil {
		return false, err
	}
	n, err := res.RowsAffected()
	if err != nil {
		return false, err
	}
	if err := tx.Commit(); err != nil {
		return false, err
	}
	committed = true
	return n > 0, nil
}

// hasAccountRecords 对应 Card._hasAccountRecords：检查卡片是否有收支记录（排除冲正）。
// from: model/index.js:475-483
func hasAccountRecords(cardID, userID string) (bool, error) {
	row, err := qRow(db.DB(),
		`SELECT COUNT(*) as cnt FROM account 
       WHERE card_id = ? AND user_id = ? AND is_deleted = 0 AND reversed_id IS NULL
       LIMIT 1`,
		cardID, userID)
	if err != nil {
		return false, err
	}
	return toF(row["cnt"]) > 0, nil
}

// hasRepayRecords 对应 Card._hasRepayRecords：检查卡片是否有还款记录。
// from: model/index.js:489-497
func hasRepayRecords(cardID string) (bool, error) {
	row, err := qRow(db.DB(),
		`SELECT COUNT(*) as cnt FROM card_repay 
       WHERE card_id = ? AND is_deleted = 0
       LIMIT 1`,
		cardID)
	if err != nil {
		return false, err
	}
	return toF(row["cnt"]) > 0, nil
}

// ===== data 读取助手（Joi default/convert 后的清洗值；nil map = data 缺失） =====

// jstr 取字符串：nil/缺省/空串 → def（对应 Joi default + Node `x || def`）。
func jstr(d map[string]any, key, def string) string {
	v, ok := d[key]
	if !ok || v == nil {
		return def
	}
	s := toStr(v)
	if s == "" {
		return def
	}
	return s
}

// strOrNil 对应 Node `x || null`：nil/空串 → nil，否则字符串值。
func strOrNil(v any) any {
	if v == nil {
		return nil
	}
	s := toStr(v)
	if s == "" {
		return nil
	}
	return s
}

// jnum 取数值：nil/缺省/不可解析 → def（对应 Joi default + Node `x || def`）。
func jnum(d map[string]any, key string, def float64) float64 {
	v, ok := d[key]
	if !ok || v == nil {
		return def
	}
	f, ok := jsNum(v)
	if !ok || math.IsNaN(f) {
		return def
	}
	return f
}

// jbool 取布尔：nil/缺省 → false；字符串按 Joi boolean convert（'true'/'false' 大小写不敏感）。
func jbool(d map[string]any, key string) bool {
	v, ok := d[key]
	if !ok || v == nil {
		return false
	}
	switch t := v.(type) {
	case bool:
		return t
	case string:
		switch strings.ToLower(t) {
		case "true":
			return true
		case "false":
			return false
		}
	}
	return truthy(v)
}

// cloneMap 浅拷贝（清洗层用：保留未知键 + 填 default，不改动原 body）。
func cloneMap(m map[string]any) map[string]any {
	out := make(map[string]any, len(m)+8)
	for k, v := range m {
		out[k] = v
	}
	return out
}

// errText 构造业务错误（对应 Node `throw new Error(msg)`，controller 原样透出 message）。
func errText(msg string) error { return &textError{msg} }

type textError struct{ msg string }

func (e *textError) Error() string { return e.msg }
