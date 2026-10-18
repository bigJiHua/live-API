package fund

import (
	"encoding/json"
	"errors"
	"net/http"
	"strconv"
	"strings"
	"time"

	"live/api/internal/db"
	"live/api/internal/resp"
	"live/api/internal/tim"

	"github.com/go-sql-driver/mysql"
)

// isDupEntryErr 判断 ER_DUP_ENTRY(1062)（对应 Node error.code === 'ER_DUP_ENTRY'）。
func isDupEntryErr(err error) bool {
	var myErr *mysql.MySQLError
	if errors.As(err, &myErr) {
		return myErr.Number == 1062
	}
	return false
}

// ============================================================================
// 基金控制器 —— from: controller/index.js
// ============================================================================

// ===== 公共助手（对应 controller 顶部函数） =====

// toNumber 对应 toNumber(value)：Number.isFinite ? n : 0。
func toNumber(value any) float64 {
	f, ok := jsNumber(value)
	if !ok {
		return 0
	}
	return f
}

// jsNumber 对应 Number(value)：返回 (值, 是否有限数)。
func jsNumber(value any) (float64, bool) {
	switch t := value.(type) {
	case nil:
		return 0, true // Number(null) = 0
	case float64:
		return t, true
	case int:
		return float64(t), true
	case int64:
		return float64(t), true
	case json.Number:
		f, err := t.Float64()
		if err != nil {
			return 0, false
		}
		return f, true
	case string:
		s := strings.TrimSpace(t)
		if s == "" {
			return 0, true // Number("") = 0
		}
		f, err := strconv.ParseFloat(s, 64)
		if err != nil {
			return 0, false
		}
		return f, true
	case bool:
		if t {
			return 1, true
		}
		return 0, true
	}
	return 0, false
}

// isBlank 对应 isBlank(value)。
func isBlank(value any) bool {
	if value == nil {
		return true
	}
	if s, ok := value.(string); ok {
		return strings.TrimSpace(s) == ""
	}
	return false
}

// validateDelta 对应 validateDelta(value, label, errors)。
func validateDelta(value any, label string, errors []string) []string {
	if !isBlank(value) {
		if _, ok := jsNumber(value); !ok {
			errors = append(errors, label+"必须是有效数字")
		}
	}
	return errors
}

// bodyData 对应 `req.body.data || req.body`（data 为对象时优先，含空对象）。
func bodyData(b resp.Body) map[string]any {
	if v, ok := b.Raw["data"]; ok {
		if m, ok := v.(map[string]any); ok {
			return m
		}
	}
	return b.Raw
}

// syncFundLatestHistory 对应 controller 的 syncFundLatestHistory(fundId, userId)：
// 由 history 汇总回写 fund 最新快照（net_value/market_val/rate）。
func syncFundLatestHistory(fundID, userID string) error {
	fund, err := findRawById(fundID, userID)
	if err != nil {
		return err
	}
	if fund == nil {
		return nil
	}
	summary, err := getHistorySummary(fundID, userID)
	if err != nil {
		return err
	}
	baseInvest := toNumber(fund["invest"])
	capitalDelta := toNumber(summary.CapitalSum)
	profitDelta := toNumber(summary.ProfitSum)
	currentInvest := baseInvest + capitalDelta
	marketVal := currentInvest + profitDelta
	newRate := "0.00%"
	if currentInvest > 0 {
		newRate = jsToFixed((profitDelta/currentInvest)*100, 2) + "%"
	}
	_, err = updateFund(fundID, userID, map[string]any{
		"net_value":  jsToFixed(profitDelta, 4),
		"market_val": jsToFixed(marketVal, 2),
		"rate":       newRate,
	})
	return err
}

// GetList 获取基金列表。from: controller/index.js:39-47
func GetList(w http.ResponseWriter, r *http.Request) {
	uid := resp.UID(r)
	list, err := findAll(uid)
	if err != nil {
		resp.JSON(w, 500, map[string]any{"status": 500, "message": "获取失败", "error": err.Error()})
		return
	}
	resp.JSON(w, 200, map[string]any{"status": 200, "message": "获取成功", "data": map[string]any{"list": list}})
}

// GetById 获取基金详情。from: controller/index.js:49-58
func GetById(w http.ResponseWriter, r *http.Request) {
	uid := resp.UID(r)
	item, err := findById(r.PathValue("id"), uid)
	if err != nil {
		resp.JSON(w, 500, map[string]any{"status": 500, "message": "获取失败", "error": err.Error()})
		return
	}
	if item == nil {
		resp.JSON(w, 404, map[string]any{"status": 404, "message": "记录不存在"})
		return
	}
	resp.JSON(w, 200, map[string]any{"status": 200, "message": "获取成功", "data": item})
}

// Create 创建基金。from: controller/index.js:60-93
func Create(w http.ResponseWriter, r *http.Request) {
	uid := resp.UID(r)
	d := bodyData(resp.Parse(r))
	var errors []string
	fundName := d["fundName"]
	share := d["share"]
	invest := d["invest"]
	buyDate := d["buyDate"]
	netValue := d["netValue"]
	marketVal := d["marketVal"]

	if !jsTruthy(fundName) {
		errors = append(errors, "基金名称")
	}
	if !jsTruthy(share) {
		errors = append(errors, "持有份额")
	} else if f, ok := jsNumber(share); !ok || f <= 0 {
		errors = append(errors, "持有份额")
	}
	if !jsTruthy(invest) {
		errors = append(errors, "初始本金")
	} else if f, ok := jsNumber(invest); !ok || f <= 0 {
		errors = append(errors, "初始本金")
	}
	if !jsTruthy(buyDate) {
		errors = append(errors, "购入日期")
	}
	if netValue != nil && netValue != "" {
		if _, ok := jsNumber(netValue); !ok {
			errors = append(errors, "累计收益")
		}
	}
	if marketVal != nil && marketVal != "" {
		if _, ok := jsNumber(marketVal); !ok {
			errors = append(errors, "初始市值")
		}
	}
	if len(errors) > 0 {
		resp.JSON(w, 400, map[string]any{"status": 400, "message": "以下字段不能为空: " + strings.Join(errors, "、")})
		return
	}

	baseInvest := jsToFixed(toNumber(invest), 2)
	item, err := createFund(CreateParams{
		UserID:       uid,
		FundName:     fundName,
		Share:        share,
		FundAccount:  d["fundAccount"],
		TradeAccount: d["tradeAccount"],
		SellOrg:      d["sellOrg"],
		FundCompany:  orStrValue(d["fundCompany"], "未填写"),
		BuyDate:      buyDate,
		NetValue:     orStrValue(netValue, "0"),
		Invest:       baseInvest,
		MarketVal:    orStrValue(marketVal, baseInvest),
		Rate:         orStrValue(d["rate"], "0.00%"),
	})
	if err != nil {
		resp.JSON(w, 500, map[string]any{"status": 500, "message": "创建失败", "error": err.Error()})
		return
	}
	resp.JSON(w, 200, map[string]any{"status": 200, "message": "创建成功", "data": item})
}

// Update 更新基金。from: controller/index.js:95-121
func Update(w http.ResponseWriter, r *http.Request) {
	uid := resp.UID(r)
	id := r.PathValue("id")
	existing, err := findById(id, uid)
	if err != nil {
		resp.JSON(w, 500, map[string]any{"status": 500, "message": "更新失败", "error": err.Error()})
		return
	}
	if existing == nil {
		resp.JSON(w, 404, map[string]any{"status": 404, "message": "记录不存在"})
		return
	}

	fieldMap := map[string]string{
		"fundName": "fund_name", "share": "share", "fundAccount": "fund_account",
		"tradeAccount": "trade_account", "sellOrg": "sell_org", "fundCompany": "fund_company",
		"buyDate": "buy_date", "netValue": "net_value", "invest": "invest",
		"marketVal": "market_val", "rate": "rate",
	}
	bodyDataMap := bodyData(resp.Parse(r))
	updates := map[string]any{}
	for key, v := range bodyDataMap {
		dbKey := fieldMap[key]
		// SYNC-A25：Node 只排除 undefined（controller/index.js:110
		//   `bodyData[key] !== undefined`），显式 null 会被写入并落库为 NULL。
		//   原 Go 额外排除 nil ⇒ 前端传 null 清空字段时静默不更新。
		if dbKey != "" {
			updates[dbKey] = v
		}
	}

	item, err := updateFund(id, uid, updates)
	if err != nil {
		resp.JSON(w, 500, map[string]any{"status": 500, "message": "更新失败", "error": err.Error()})
		return
	}
	resp.JSON(w, 200, map[string]any{"status": 200, "message": "更新成功", "data": item})
}

// Delete 删除基金（软删）。from: controller/index.js:123-132
func Delete(w http.ResponseWriter, r *http.Request) {
	uid := resp.UID(r)
	ok, err := deleteFund(r.PathValue("id"), uid)
	if err != nil {
		resp.JSON(w, 500, map[string]any{"status": 500, "message": "删除失败", "error": err.Error()})
		return
	}
	if !ok {
		resp.JSON(w, 404, map[string]any{"status": 404, "message": "记录不存在"})
		return
	}
	resp.JSON(w, 200, map[string]any{"status": 200, "message": "删除成功"})
}

// GetHistory 获取净值历史。from: controller/index.js:134-163
func GetHistory(w http.ResponseWriter, r *http.Request) {
	uid := resp.UID(r)
	id := r.PathValue("id")
	q := r.URL.Query()
	limit := 400
	if v := q.Get("limit"); v != "" {
		limit = jsParseInt(v)
	}
	startDate := q.Get("startDate")
	endDate := q.Get("endDate")

	rows, err := getHistoryRows(id, uid, HistoryOptions{Limit: limit, StartDate: startDate, EndDate: endDate})
	if err != nil {
		resp.JSON(w, 500, map[string]any{"status": 500, "message": "获取失败", "error": err.Error()})
		return
	}
	profitBefore := any(0)
	capitalBefore := any(0)
	if startDate != "" {
		summary, err := getHistorySummaryBefore(id, uid, startDate)
		if err != nil {
			resp.JSON(w, 500, map[string]any{"status": 500, "message": "获取失败", "error": err.Error()})
			return
		}
		profitBefore = orZero(summary.ProfitSum)
		capitalBefore = orZero(summary.CapitalSum)
	}
	var startDateVal, endDateVal any
	if startDate != "" {
		startDateVal = startDate
	}
	if endDate != "" {
		endDateVal = endDate
	}
	resp.JSON(w, 200, map[string]any{
		"status": 200, "message": "获取成功",
		"data": map[string]any{
			"list": rows,
			"range": map[string]any{
				"startDate":     startDateVal,
				"endDate":       endDateVal,
				"profitBefore":  profitBefore,
				"capitalBefore": capitalBefore,
			},
		},
	})
}

// GetMonthlyHistory 获取月度历史。from: controller/index.js:165-177
func GetMonthlyHistory(w http.ResponseWriter, r *http.Request) {
	uid := resp.UID(r)
	id := r.PathValue("id")
	q := r.URL.Query()
	now := tim.Now()
	y := now.Year()
	m := int(now.Month())
	// 对应 parseInt(year) || new Date().getFullYear()：NaN/0 → 回退当前
	if v := q.Get("year"); v != "" {
		if n := jsParseInt(v); n != 0 {
			y = n
		}
	}
	if v := q.Get("month"); v != "" {
		if n := jsParseInt(v); n != 0 {
			m = n
		}
	}
	data, err := getHistoryMonthly(id, uid, y, m)
	if err != nil {
		resp.JSON(w, 500, map[string]any{"status": 500, "message": "获取失败", "error": err.Error()})
		return
	}
	resp.JSON(w, 200, map[string]any{
		"status": 200, "message": "获取成功",
		"data": map[string]any{
			"records":          data.Records,
			"beforeProfit":     data.BeforeProfit,
			"beforeCapital":    data.BeforeCapital,
			"latestRecordDate": data.LatestRecordDate,
		},
	})
}

// GetAllHistory 获取全部净值历史。from: controller/index.js:179-188
func GetAllHistory(w http.ResponseWriter, r *http.Request) {
	uid := resp.UID(r)
	limit := 180
	if v := r.URL.Query().Get("limit"); v != "" {
		if n := jsParseInt(v); n != 0 {
			limit = n
		}
	}
	rows, err := getAllHistoryRows(uid, limit)
	if err != nil {
		resp.JSON(w, 500, map[string]any{"status": 500, "message": "获取失败", "error": err.Error()})
		return
	}
	resp.JSON(w, 200, map[string]any{"status": 200, "message": "获取成功", "data": map[string]any{"list": rows}})
}

// AddHistory 写入净值历史。from: controller/index.js:190-219
func AddHistory(w http.ResponseWriter, r *http.Request) {
	uid := resp.UID(r)
	id := r.PathValue("id")
	existing, err := findById(id, uid)
	if err != nil {
		resp.JSON(w, 500, map[string]any{"status": 500, "message": "写入失败", "error": err.Error()})
		return
	}
	if existing == nil {
		resp.JSON(w, 404, map[string]any{"status": 404, "message": "基金不存在"})
		return
	}
	d := bodyData(resp.Parse(r))
	netValue := d["netValue"]
	marketVal := d["marketVal"]
	recordDate := d["recordDate"]
	if !jsTruthy(recordDate) {
		resp.JSON(w, 400, map[string]any{"status": 400, "message": "日期不能为空"})
		return
	}
	if isBlank(netValue) && isBlank(marketVal) {
		resp.JSON(w, 400, map[string]any{"status": 400, "message": "今日收益和增持本金至少填写一项"})
		return
	}
	var errors []string
	errors = validateDelta(netValue, "今日收益", errors)
	errors = validateDelta(marketVal, "增持本金", errors)
	if len(errors) > 0 {
		resp.JSON(w, 400, map[string]any{"status": 400, "message": strings.Join(errors, "，")})
		return
	}

	// 同一基金同一日期只允许一条记录
	dup, err := DupHistory(id, toStrValue(recordDate))
	if err != nil {
		resp.JSON(w, 500, map[string]any{"status": 500, "message": "写入失败", "error": err.Error()})
		return
	}
	if dup {
		resp.JSON(w, 400, map[string]any{"status": 400, "message": "该日期已有记录，请编辑或删除"})
		return
	}

	nv := any("0")
	if !isBlank(netValue) {
		nv = netValue
	}
	mv := any("0")
	if !isBlank(marketVal) {
		mv = marketVal
	}
	historyID, err := addHistoryRow(id, nv, mv, recordDate)
	if err != nil {
		// 🔄 2026-10-13（api.md P2-10）：唯一键 uk_fund_record_date 建立后，
		//    并发双写（查重未命中→双 INSERT）由 DB 兜底抛 ER_DUP_ENTRY(1062)。
		//    转成与上方查重一致的友好 400，不再裸 500。
		if isDupEntryErr(err) {
			resp.JSON(w, 400, map[string]any{"status": 400, "message": "该日期已有记录，请编辑或删除"})
			return
		}
		resp.JSON(w, 500, map[string]any{"status": 500, "message": "写入失败", "error": err.Error()})
		return
	}
	if err := syncFundLatestHistory(id, uid); err != nil {
		resp.JSON(w, 500, map[string]any{"status": 500, "message": "写入失败", "error": err.Error()})
		return
	}
	resp.JSON(w, 200, map[string]any{"status": 200, "message": "记录成功", "data": map[string]any{"id": historyID}})
}

// UpdateHistory 修改历史记录。from: controller/index.js:221-239
func UpdateHistory(w http.ResponseWriter, r *http.Request) {
	uid := resp.UID(r)
	id := r.PathValue("id")
	existing, err := findHistoryById(id, uid)
	if err != nil {
		resp.JSON(w, 500, map[string]any{"status": 500, "message": "修改失败", "error": err.Error()})
		return
	}
	if existing == nil {
		resp.JSON(w, 404, map[string]any{"status": 404, "message": "记录不存在"})
		return
	}
	d := bodyData(resp.Parse(r))
	netValue := d["netValue"]
	marketVal := d["marketVal"]
	var errors []string
	errors = validateDelta(netValue, "今日收益", errors)
	errors = validateDelta(marketVal, "增持本金", errors)
	if len(errors) > 0 {
		resp.JSON(w, 400, map[string]any{"status": 400, "message": strings.Join(errors, "，")})
		return
	}
	// 🔒 SYNC-A43：存在性判定（`v, ok :=`），显式 null 也要传给 model 落库为 NULL。
	rawNetValue, netValueSet := d["netValue"]
	rawMarketVal, marketValSet := d["marketVal"]
	ok, err := updateHistoryRow(id, uid, rawNetValue, rawMarketVal, netValueSet, marketValSet)
	if err != nil {
		resp.JSON(w, 500, map[string]any{"status": 500, "message": "修改失败", "error": err.Error()})
		return
	}
	if !ok {
		resp.JSON(w, 404, map[string]any{"status": 404, "message": "记录不存在"})
		return
	}
	if err := syncFundLatestHistory(toStrValue(existing["fund_id"]), uid); err != nil {
		resp.JSON(w, 500, map[string]any{"status": 500, "message": "修改失败", "error": err.Error()})
		return
	}
	resp.JSON(w, 200, map[string]any{"status": 200, "message": "修改成功"})
}

// DeleteHistory 删除历史记录。from: controller/index.js:241-254
func DeleteHistory(w http.ResponseWriter, r *http.Request) {
	uid := resp.UID(r)
	id := r.PathValue("id")
	existing, err := findHistoryById(id, uid)
	if err != nil {
		resp.JSON(w, 500, map[string]any{"status": 500, "message": "删除失败", "error": err.Error()})
		return
	}
	if existing == nil {
		resp.JSON(w, 404, map[string]any{"status": 404, "message": "记录不存在"})
		return
	}
	ok, err := deleteHistoryRow(id, uid)
	if err != nil {
		resp.JSON(w, 500, map[string]any{"status": 500, "message": "删除失败", "error": err.Error()})
		return
	}
	if !ok {
		resp.JSON(w, 404, map[string]any{"status": 404, "message": "记录不存在"})
		return
	}
	if err := syncFundLatestHistory(toStrValue(existing["fund_id"]), uid); err != nil {
		resp.JSON(w, 500, map[string]any{"status": 500, "message": "删除失败", "error": err.Error()})
		return
	}
	resp.JSON(w, 200, map[string]any{"status": 200, "message": "删除成功"})
}

// ===== 本文件助手 =====

// jsTruthy 对应 JS 真值（空字符串/0/NaN/null/undefined 为假）。
func jsTruthy(v any) bool {
	switch t := v.(type) {
	case nil:
		return false
	case string:
		return t != ""
	case float64:
		return t != 0 && !isNaN64(t)
	case int:
		return t != 0
	case int64:
		return t != 0
	case json.Number:
		f, err := t.Float64()
		if err != nil {
			return false
		}
		return f != 0
	case bool:
		return t
	}
	return true
}

func isNaN64(f float64) bool { return f != f }

// orStrValue 对应 `x || def`（JS 真值判定：undefined/null/空串/**0/false/NaN** → def）。
//
// 🔒 SYNC-A43（2026-10-13）：旧实现只挡 nil 与空串，而 jsNumber(0) 命中 `case float64`
// 返回 ("0", true) ⇒ 数字 0 时返回 "0"，而 JS `0 || def` 返回 def。
// 后果（Node fund/controller/index.js:81-86 的 `marketVal || baseInvest` /
// `rate || '0.00%'` / `fundCompany || '未填写'`）：
//
//	传 marketVal=0 ⇒ Node 落 baseInvest、Go 落 "0"
//	传 rate=0      ⇒ Node 落 "0.00%"、Go 落 "0"
func orStrValue(v any, def string) string {
	if !jsTruthy(v) { // 0 / "" / null / false / NaN 均 falsy，对齐 `x || def`
		return def
	}
	if s, ok := v.(string); ok {
		return s
	}
	if f, ok := jsNumber(v); ok {
		return strconv.FormatFloat(f, 'f', -1, 64)
	}
	return def
}

// toStrValue 对应 String(value) 常用子集。
func toStrValue(v any) string {
	switch t := v.(type) {
	case nil:
		return ""
	case string:
		return t
	case float64:
		return strconv.FormatFloat(t, 'f', -1, 64)
	case json.Number:
		return t.String()
	case bool:
		if t {
			return "true"
		}
		return "false"
	}
	return ""
}

// orZero 对应 `x || 0`（nil → 0）。
func orZero(v any) any {
	if v == nil {
		return 0
	}
	return v
}

// jsParseInt 对应 parseInt(v, 10)：不可解析 → 0（调用方按 0 回退默认值）。
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

// ===== DB 行助手 =====

// queryRows 查询多行并转 []map（列名 → 值）。
func queryRows(ex db.Commiter, query string, args ...any) ([]map[string]any, error) {
	rows, err := ex.Query(query, args...)
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

// queryRow 查询首行；无行返回 (nil, nil)。
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

// normVal DB 值 → JSON 友好值：[]byte→string；time.Time→Node JSON.stringify(Date) UTC ISO 串。
func normVal(v any) any {
	switch t := v.(type) {
	case []byte:
		return string(t)
	case time.Time:
		return t.UTC().Format("2006-01-02T15:04:05.000Z")
	}
	return v
}
