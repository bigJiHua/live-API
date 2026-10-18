package flow

import (
	"fmt"
	"net/http"
	"regexp"
	"strconv"
	"strings"
	"time"

	"live/api/internal/db"
	"live/api/internal/resp"
	"live/api/internal/tim"
)

// reYear / reMonth 对应 Node 的 /^\d{4}$/ 与 /^\d{1,2}$/（api.md P3-16）。
var (
	reYear  = regexp.MustCompile(`^\d{4}$`)
	reMonth = regexp.MustCompile(`^\d{1,2}$`)
)

// Calendar 流水日历：按月聚合每日收入/支出。
// from: modules/flow/api/index.js:8-42
func Calendar(w http.ResponseWriter, r *http.Request) {
	uid := resp.UID(r)
	q := r.URL.Query()
	year := q.Get("year")
	month := q.Get("month")

	// 🔄 2026-10-13（api.md P3-16）：参数校验，缺参不再生成 "undefined-undefined-01"
	if year == "" || month == "" || !reYear.MatchString(year) || !reMonth.MatchString(month) {
		resp.Say(w, "year/month 参数不合法", 400)
		return
	}

	// m = String(month).padStart(2, '0')
	m := month
	for len(m) < 2 {
		m = "0" + m
	}
	startDate := fmt.Sprintf("%s-%s-01", year, m)
	// nextMonth = parseInt(month) + 1；y2 = nextMonth > 12 ? year+1 : year；m2 同理
	nextMonth := jsParseInt(month) + 1
	y2 := jsParseInt(year)
	m2 := nextMonth
	if nextMonth > 12 {
		y2 = jsParseInt(year) + 1
		m2 = 1
	}
	endDate := fmt.Sprintf("%04d-%02d-01", y2, m2)

	rows, err := queryRows(db.DB(), `
      SELECT DATE(trans_date) as date,
              COALESCE(SUM(CASE WHEN direction = 1 THEN amount ELSE 0 END), 0) as income,
              COALESCE(SUM(CASE WHEN direction = 0 THEN amount ELSE 0 END), 0) as expense
       FROM account
       WHERE user_id = ? AND is_deleted = 0 AND trans_date >= ? AND trans_date < ?
       GROUP BY DATE(trans_date) ORDER BY date`,
		uid, startDate, endDate)
	if err != nil {
		// 🔄 2026-10-13（api.md P2-13）：不再吞错返 200 空数据
		resp.SayErr(w, err, 500)
		return
	}

	result := map[string]any{}
	for _, f := range rows {
		// DATE(trans_date) 为 DATE 列：键取 YYYY-MM-DD（mysql2 会返回 Date 对象，
		// Node 用作对象键时退化为 Date.toString；此处取日期串，符合列语义与桌面端消费）。
		result[dateOnly(f["date"])] = map[string]any{
			"income":  orZero(f["income"]),
			"expense": orZero(f["expense"]),
		}
	}
	resp.JSON(w, 200, map[string]any{"status": 200, "data": result})
}

// dateOnly time.Time → "YYYY-MM-DD"（服务器本地 = Asia/Shanghai，与 Node 主机一致）；其余原样转字符串。
func dateOnly(v any) string {
	switch t := v.(type) {
	case time.Time:
		return t.In(tim.Loc()).Format("2006-01-02")
	case string:
		return t
	case []byte:
		return string(t)
	}
	return toStr(v)
}

// ===== 助手 =====

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
		mp := make(map[string]any, len(cols))
		for i, c := range cols {
			mp[c] = normVal(vals[i])
		}
		out = append(out, mp)
	}
	return out, rows.Err()
}

// normVal []byte→string；time.Time 原样透传（Calendar 的 DATE(trans_date) 列由
// dateOnly 统一转本地 YYYY-MM-DD，不得在此提前转 UTC ISO —— 会既改格式又偏移一天）。
func normVal(v any) any {
	if b, ok := v.([]byte); ok {
		return string(b)
	}
	return v
}

// toStr 对应 String(v) 常用子集。
func toStr(v any) string {
	switch t := v.(type) {
	case nil:
		return ""
	case string:
		return t
	case []byte:
		return string(t)
	case float64:
		return strconv.FormatFloat(t, 'f', -1, 64)
	}
	return fmt.Sprintf("%v", v)
}

// orZero 对应 `x || 0`（nil → 0）。
func orZero(v any) any {
	if v == nil {
		return 0
	}
	return v
}

// jsParseInt 对应 parseInt(v, 10)：不可解析 → 0。
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
