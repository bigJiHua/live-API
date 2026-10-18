package todo

import (
	"encoding/json"
	"math"
	"sort"
	"strconv"
	"strings"
	"time"

	"live/api/internal/config"
	"live/api/internal/db"
)

// ===== 行 → map 工具（与 cardbill 包各自的私有副本，避免共享导出面） =====

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

// normVal DB 值 → JSON 友好值：[]byte→string（mysql2 DECIMAL/CHAR 返回串）；
// time.Time→Node JSON.stringify(Date) 的 UTC ISO 串；其余原样。
func normVal(v any) any {
	switch t := v.(type) {
	case []byte:
		return string(t)
	case time.Time:
		return t.UTC().Format("2006-01-02T15:04:05.000Z")
	}
	return v
}

// execAffected Exec 并返回 affectedRows。
func execAffected(ex db.Commiter, q string, args ...any) (int64, error) {
	res, err := ex.Exec(q, args...)
	if err != nil {
		return 0, err
	}
	n, err := res.RowsAffected()
	if err != nil {
		return 0, err
	}
	return n, nil
}

// ===== JS 语义值转换 =====

// truthyJS 对应 JS 真值判断（空串/0/NaN 为假，含 JSON 数字 0）。
func truthyJS(v any) bool {
	switch t := v.(type) {
	case nil:
		return false
	case bool:
		return t
	case string:
		return t != ""
	case json.Number:
		f, err := t.Float64()
		return err == nil && f != 0 && !math.IsNaN(f)
	case float64:
		return t != 0 && !math.IsNaN(t)
	case int64:
		return t != 0
	case int:
		return t != 0
	}
	return true
}

// orJS 对应 JS a || b。
func orJS(a, b any) any {
	if truthyJS(a) {
		return a
	}
	return b
}

// jsNumber 对应 JS Number(v)。
func jsNumber(v any) float64 {
	switch t := v.(type) {
	case nil:
		return 0
	case bool:
		if t {
			return 1
		}
		return 0
	case string:
		s := strings.TrimSpace(t)
		if s == "" {
			return 0
		}
		f, err := strconv.ParseFloat(s, 64)
		if err != nil {
			return math.NaN()
		}
		return f
	case json.Number:
		f, err := t.Float64()
		if err != nil {
			return math.NaN()
		}
		return f
	case float64:
		return t
	case int64:
		return float64(t)
	case int:
		return float64(t)
	}
	return math.NaN()
}

// jsInt 对应 JS 数值化取整（真值 → Number 截断；假值 → 0）。
func jsInt(v any) int {
	if !truthyJS(v) {
		return 0
	}
	return int(jsNumber(v))
}

// jsParseFloatLoose 对应 JS parseFloat：宽松前缀解析，失败 NaN。
func jsParseFloatLoose(s string) float64 {
	s = strings.TrimSpace(s)
	end, seenDigit := 0, false
	seenDot := false
loop:
	for i := 0; i < len(s); i++ {
		c := s[i]
		switch {
		case c >= '0' && c <= '9':
			seenDigit = true
			end = i + 1
		case c == '.' && !seenDot && seenDigit:
			seenDot = true
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

// toStrJS 对应 JS String(v)（常用子集）。
func toStrJS(v any) string {
	switch t := v.(type) {
	case nil:
		return ""
	case string:
		return t
	case json.Number:
		return t.String()
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

// orStrJS 对应 JS v || def（字符串场景）。
func orStrJS(v any, def string) string {
	if truthyJS(v) {
		return toStrJS(v)
	}
	return def
}

func isNaN(f float64) bool { return math.IsNaN(f) }

// mustJSONString JSON.stringify（marshal 失败返回 "null"，对应 Node 异常外默认）。
func mustJSONString(v any) string {
	b, err := json.Marshal(v)
	if err != nil {
		return "null"
	}
	return string(b)
}

// sortedKeys 对应 Object.keys(m).sort()。
func sortedKeys(m map[string]any) []string {
	keys := make([]string, 0, len(m))
	for k := range m {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	return keys
}

// indexOf 对应 Array#indexOf。
func indexOf(ss []string, s string) int {
	for i, v := range ss {
		if v == s {
			return i
		}
	}
	return -1
}

// envGraceDays 对应 Number(process.env.INSTALLMENT_GRACE_DAYS) || 30。
func envGraceDays() int {
	if v := config.Get("INSTALLMENT_GRACE_DAYS", ""); v != "" {
		if n, err := strconv.Atoi(strings.TrimSpace(v)); err == nil && n != 0 {
			return n
		}
	}
	return 30
}
