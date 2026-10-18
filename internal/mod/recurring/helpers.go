package recurring

import (
	"bytes"
	"encoding/json"
	"math"
	"strconv"
	"strings"
	"time"

	"live/api/internal/db"
	"live/api/internal/tim"
)

// ===== 本包公共助手（对齐 JS 松散语义与 DB 行口径） =====

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

// normVal []byte→string；time.Time→Node JSON.stringify(Date) 的 UTC ISO 串。
func normVal(v any) any {
	switch t := v.(type) {
	case []byte:
		return string(t)
	case time.Time:
		return t.UTC().Format("2006-01-02T15:04:05.000Z")
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
	case float64:
		return strconv.FormatFloat(t, 'f', -1, 64)
	case int:
		return strconv.Itoa(t)
	case int64:
		return strconv.FormatInt(t, 10)
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

// toF 对应 parseFloat(x) || 0（不可解析/NULL → 0）。
func toF(v any) float64 {
	switch t := v.(type) {
	case nil:
		return 0
	case float64:
		return t
	case int:
		return float64(t)
	case int64:
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
	}
	return 0
}

// toFNaN 对应 parseFloat(x)（NULL → NaN，用于 keep BUG-039 的 need_repay 判定）。
func toFNaN(v any) float64 {
	if v == nil {
		return math.NaN()
	}
	return toF(v)
}

// jsTruthy 对应 JS 真值。
func jsTruthy(v any) bool {
	switch t := v.(type) {
	case nil:
		return false
	case bool:
		return t
	case string:
		return t != ""
	case float64:
		return t != 0
	case int:
		return t != 0
	case int64:
		return t != 0
	case json.Number:
		return t.String() != "" && t.String() != "0"
	}
	return true
}

// parseIntValue 对应 parseInt(x, 10) || 0。
func parseIntValue(v any) int { return int(toF(v)) }

// isActive01 对应 `isActive === false || isActive === 0 ? 0 : 1`。
func isActive01(v any) int {
	switch t := v.(type) {
	case bool:
		if !t {
			return 0
		}
	case float64:
		if t == 0 {
			return 0
		}
	case int:
		if t == 0 {
			return 0
		}
	case int64:
		if t == 0 {
			return 0
		}
	// 🔒 SYNC-A43（2026-10-13）：删除对字符串 "0" / "" 的特殊处理。
	// Node recurring/model/index.js:280 是严格比较
	//     isActive === false || isActive === 0 ? 0 : 1
	// 字符串 "0" 既 `!== false` 也 `!== 0` ⇒ **Node 存 is_active = 1**（启用）。
	// 旧实现把 "0" 当 0 ⇒ 同一请求两端结果相反。
	// Node 实测：'0' === false || '0' === 0 ? 0 : 1  ⇒  1
	//
	// 注：DB 读取路径不受影响（is_active 是 tinyint，读出来是 int64，走上面的分支）。
	case string, json.Number:
		// fallthrough 到末尾 return 1
	}
	return 1
}

// orNull 对应 `x || null`。
func orNull(v any) any {
	if !jsTruthy(v) {
		return nil
	}
	return v
}

// clampInt 对应 Math.max(lo, Math.min(hi, x))。
func clampInt(x, lo, hi int) int {
	if x < lo {
		return lo
	}
	if x > hi {
		return hi
	}
	return x
}

// pad2 对应 String(n).padStart(2, '0')。
func pad2(n int) string {
	s := strconv.Itoa(n)
	if len(s) < 2 {
		s = "0" + s
	}
	return s
}

// daysInMonthYM 对应 new Date(year, month, 0).getDate()（month 为 1-12，北京时区）。
func daysInMonthYM(year, month int) int {
	return time.Date(year, time.Month(month)+1, 0, 0, 0, 0, 0, tim.Loc()).Day()
}

// jsonStringify 对应 JSON.stringify(obj)（Go map 键按字典序序列化；
// month_records 的 "YYYY-MM" 键字典序即时间序，与 JS 插入序实际等价）。
func jsonStringify(v any) (string, error) {
	var buf bytes.Buffer
	enc := json.NewEncoder(&buf)
	enc.SetEscapeHTML(false)
	if err := enc.Encode(v); err != nil {
		return "", err
	}
	return strings.TrimRight(buf.String(), "\n"), nil
}

// parseJSONObject 对应 JSON.parse（失败 → nil）；数字保留 json.Number 以逐字回写。
func parseJSONObject(s string) map[string]any {
	if s == "" {
		return nil
	}
	dec := json.NewDecoder(strings.NewReader(s))
	dec.UseNumber()
	var m map[string]any
	if err := dec.Decode(&m); err != nil {
		return nil
	}
	return m
}
