package work

import (
	"encoding/json"
	"errors"
	"math"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	"live/api/internal/db"
)

// ===== 本包公共助手（对齐 JS 松散语义与 DB 行口径） =====

// errOrdinary 对应 throw new Error(msg)（业务错误，message 原样透出）。
func errOrdinary(msg string) error { return errors.New(msg) }

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

// toF 对应 parseFloat(x) || 0（不可解析 → 0）。
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
		// 🔒 SYNC-A43：ParseFloat("NaN",64) 返回 (NaN, **nil**) ⇒ 只判 err 拦不住。
		if err != nil || math.IsNaN(f) {
			return 0
		}
		return f
	case string:
		f, err := strconv.ParseFloat(strings.TrimSpace(t), 64)
		// ⚠ 只挡 NaN，**不挡 Inf**：Node 的 parseFloat("Infinity")||0 仍是 Infinity
		//（truthy），最终由 MySQL DOUBLE 列拒绝 → 两端都 500。挡掉反而制造偏差。
		if err != nil || math.IsNaN(f) {
			return 0
		}
		return f
	}
	return 0
}

// jsParseIntValue 对应 parseInt(x, 10) || 0。
func jsParseIntValue(v any) int { return int(toF(v)) }

// jsParseInt 对应 parseInt(s, 10)：不可解析 → 0。
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
		f, err := t.Float64()
		if err != nil {
			return false
		}
		return f != 0
	}
	return true
}

// orDef 对应 `x || def`（JS falsy：nil/空串/0 → def）。
func orDef(v any, def any) any {
	if !jsTruthy(v) {
		return def
	}
	return v
}

// orNullValue 对应 `x || null`。
func orNullValue(v any) any {
	if !jsTruthy(v) {
		return nil
	}
	return v
}

// jsNumLessThan 对应 JS `x < 0`：非数字（含不可解析字符串）→ false。
func jsNumLessThan(v any, zero float64) bool {
	switch t := v.(type) {
	case float64:
		return t < zero
	case int:
		return float64(t) < zero
	case int64:
		return float64(t) < zero
	case json.Number:
		f, err := t.Float64()
		if err != nil {
			return false
		}
		return f < zero
	case string:
		f, err := strconv.ParseFloat(strings.TrimSpace(t), 64)
		if err != nil {
			return false
		}
		return f < zero
	}
	return false
}

// runeLen 对应 JS String.length 的常用近似（备注为中文，按 rune 计）。
func runeLen(s string) int { return utf8.RuneCountInString(s) }

// joinFields 拼接 SET 子句。
func joinFields(fields []string) string { return strings.Join(fields, ", ") }

// pad2 对应 String(n).padStart(2, '0')。
func pad2(n int) string {
	s := strconv.Itoa(n)
	if len(s) < 2 {
		s = "0" + s
	}
	return s
}

// daysInMonth 对应 new Date(year, month+1, 0).getDate()（month 为 1-12）。
func daysInMonth(year, month int) int {
	return time.Date(year, time.Month(month)+1, 0, 0, 0, 0, 0, time.Local).Day()
}

// round2 对应 Math.round(x*100)/100（JS Math.round = floor(x+0.5)，ties 朝 +∞）。
func round2(x float64) float64 {
	return math.Floor(x*100+0.5) / 100
}
