// Package resp 复刻 Express 的 res.say / res.json 应答契约与 body 解析语义。
package resp

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"strconv"
	"strings"
)

// ctxKey 用于在 context 中传递 userId（对应 req.userId）。
type ctxKey int

const (
	keyUID ctxKey = iota
	keyBody
	keyDevice
	keySecurity
	keyCheckedUser
)

// Say 等价 res.say(err, status)：HTTP 状态默认 206，body 为 {status, message}；
// status 传 0 表示 Node 端 undefined 场景（body 省略 status 键）。
// 5xx 且非 dev 环境文案脱敏为"服务器内部错误"由调用方按需处理。
func Say(w http.ResponseWriter, message any, status int) {
	httpStatus := status
	if httpStatus == 0 {
		httpStatus = 206
	}
	body := map[string]any{}
	if status != 0 {
		body["status"] = status
	}
	body["message"] = message
	writeJSON(w, httpStatus, body)
}

// SayErr 对应 res.say(new Error(...), 5xx) 的脱敏行为。
func SayErr(w http.ResponseWriter, err error, status int) {
	msg := err.Error()
	if status >= 500 && !IsDev() {
		msg = "服务器内部错误"
	}
	Say(w, msg, status)
}

// JSON 等价 res.json(obj) / res.status(x).json(obj)。
//
// 🔒 SYNC-004（2026-10-11）：5xx 响应体统一脱敏 —— 对齐 Node buildErrorBody 的生产语义。
//
//	业务 handler 普遍写 resp.JSON(w, 500, map[string]any{"message": ..., "error": err.Error()})，
//	内部报错（SQL 片段/表名）直接回给客户端。在此集中处理：
//	**生产删除 "error" 键**（客户端只读 message/status，行为零变化）；dev 保留便于调试。
func JSON(w http.ResponseWriter, httpStatus int, obj any) {
	if httpStatus >= 500 {
		if m, ok := obj.(map[string]any); ok {
			if _, has := m["error"]; has && !IsDev() {
				delete(m, "error")
			}
		}
	}
	writeJSON(w, httpStatus, obj)
}

// SayErrBody 对齐 Node 的 `res.json({ status, ...buildErrorBody(message, error) })`。
//
// 🔒 SYNC-A42（2026-10-13）：Node logFields.js:83-95 的语义是
//
//	function buildErrorDetail(error) {
//	  if (production) return {};                              // 生产：只有 message
//	  return { error: error?.message ?? String(error) };      // 非生产：追加 error
//	}
//	function buildErrorBody(message, error) { return { message, ...buildErrorDetail(error) }; }
//
// 即 **`message` 恒为调用方给的固定文案**，与 error 无关。
//
//	此前大量 handler 写成 `orMsg(err.Error(), "查询失败")` —— 用错误原文替换掉了固定文案，
//	而 JSON() 只剥 "error" 键、不管 "message" ⇒ **完全绕过了脱敏**，
//	生产环境把 SQL 报错原文（表名/列名/查询片段/驱动错误）直接回显给客户端。
//
//	现在 5xx 应统一走本函数：生产只回固定文案，非生产附带 error 明细。
func SayErrBody(w http.ResponseWriter, httpStatus int, message string, err error) {
	body := map[string]any{"status": httpStatus, "message": message}
	// 非生产时附上错误明细（对齐 buildErrorDetail）；生产不加 ⇒ 零泄露。
	if IsDev() && err != nil {
		body["error"] = err.Error()
	}
	JSON(w, httpStatus, body)
}

func writeJSON(w http.ResponseWriter, httpStatus int, obj any) {
	buf, err := json.Marshal(obj)
	if err != nil {
		w.Header().Set("Content-Type", "application/json; charset=utf-8")
		w.WriteHeader(500)
		_, _ = w.Write([]byte(`{"status":500,"message":"响应序列化失败"}`))
		return
	}
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(httpStatus)
	_, _ = w.Write(buf)
}

// Body 对应解密后的 req.body：Node 侧 handler 用 req.body.data || req.body 兼容。
type Body struct {
	Raw  map[string]any
	Data map[string]any
}

// Parse 读取并解析 body；若 BodyLoader 中间件已解析（context 中有 Body），直接复用。
func Parse(r *http.Request) Body {
	if v, ok := r.Context().Value(keyBody).(Body); ok {
		return v
	}
	b := Body{Raw: map[string]any{}, Data: map[string]any{}}
	if r.Body == nil {
		return b
	}
	raw, err := io.ReadAll(io.LimitReader(r.Body, 32<<20))
	if err != nil || len(raw) == 0 {
		return b
	}
	var m map[string]any
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.UseNumber()
	if err := dec.Decode(&m); err != nil || m == nil {
		return b
	}
	b.Raw = m
	if d, ok := m["data"].(map[string]any); ok {
		b.Data = d
	}
	return b
}

// WithBody 将解析后的 body 存入 context。
func WithBody(r *http.Request, b Body) *http.Request {
	return r.WithContext(context.WithValue(r.Context(), keyBody, b))
}

// DataOrRaw 返回 data（存在且为对象时）否则 raw 本身，对应 `req.body.data || req.body`。
// 注意：JS 中 `{}` 为 truthy ⇒ data 为空对象时仍返回 data（不回退顶层），
// 故判据是「data 键存在且为对象」而非「data 非空」。
func (b Body) DataOrRaw() map[string]any {
	if v, ok := b.Raw["data"]; ok {
		if m, ok := v.(map[string]any); ok {
			return m
		}
	}
	return b.Raw
}

// Str 取字符串字段：取不到返回 def。
func (b Body) Str(key string, def ...string) string {
	d := ""
	if len(def) > 0 {
		d = def[0]
	}
	v, ok := b.lookup(key)
	if !ok || v == nil {
		return d
	}
	switch t := v.(type) {
	case string:
		if t == "" {
			return d
		}
		return t
	case json.Number:
		return t.String()
	case float64:
		return strconv.FormatFloat(t, 'f', -1, 64)
	case bool:
		if t {
			return "true"
		}
		return "false"
	}
	return d
}

// Has 判断字段存在且非 nil。
func (b Body) Has(key string) bool {
	v, ok := b.lookup(key)
	return ok && v != nil
}

// Float 取浮点（JS Number 语义：字符串数字可转换）。
func (b Body) Float(key string) (float64, bool) {
	v, ok := b.lookup(key)
	if !ok || v == nil {
		return 0, false
	}
	switch t := v.(type) {
	case json.Number:
		f, err := t.Float64()
		return f, err == nil
	case float64:
		return t, true
	case string:
		f, err := strconv.ParseFloat(strings.TrimSpace(t), 64)
		return f, err == nil
	}
	return 0, false
}

// Int 取整数。
func (b Body) Int(key string) (int, bool) {
	f, ok := b.Float(key)
	if !ok {
		return 0, false
	}
	return int(f), true
}

// Bool 取布尔。
func (b Body) Bool(key string) bool {
	v, ok := b.lookup(key)
	if !ok {
		return false
	}
	switch t := v.(type) {
	case bool:
		return t
	case string:
		return t == "true" || t == "1"
	case json.Number:
		return t.String() != "0"
	}
	return false
}

// Map 取子对象。
func (b Body) Map(key string) map[string]any {
	v, ok := b.lookup(key)
	if !ok {
		return nil
	}
	if m, ok := v.(map[string]any); ok {
		return m
	}
	return nil
}

// Slice 取数组。
func (b Body) Slice(key string) []any {
	v, ok := b.lookup(key)
	if !ok {
		return nil
	}
	if s, ok := v.([]any); ok {
		return s
	}
	return nil
}

// lookup 支持 "data.xxx" 前缀。
//
// 🔒 SYNC-A44（2026-10-13）：显式 data. 前缀时**只在 Data 里找**，不再回落 Raw。
//
//	Node 的写法是 req.body.data?.X 或 const {X} = req.body.data || {}
//
// ⇒ body 里没有 data 字段时，取值结果恒为 undefined。
//
//	旧实现剥掉 "data." 前缀后会去 Raw 里找同名顶层键，于是
//	把参数放在顶层的 JSON（{"nameOrEmail":"x",...}）与表单编码
//	（nameOrEmail=x&password=y）都能通过登录参数校验 —— 而 Node 两者都拒绝。
//	结果：多出一条 Node 不允许的登录通道（凭据可出现在 URL 编码体里）。
//
//	现在：带 data. 前缀 ⇒ 只在 Data 里找；不带前缀 ⇒ 维持原有回落行为。
func (b Body) lookup(key string) (any, bool) {
	k := key
	hasDataPrefix := strings.HasPrefix(k, "data.")
	if hasDataPrefix {
		k = strings.TrimPrefix(k, "data.")
	}
	if len(b.Data) > 0 {
		if v, ok := b.Data[k]; ok {
			return v, true
		}
	}
	if hasDataPrefix {
		return nil, false // 对齐 Node：body.data 缺失 ⇒ 取值 undefined
	}
	if v, ok := b.Raw[k]; ok {
		return v, true
	}
	return nil, false
}

// ===== context 存取 =====

func WithUID(r *http.Request, uid string) *http.Request {
	return r.WithContext(context.WithValue(r.Context(), keyUID, uid))
}

func UID(r *http.Request) string {
	v, _ := r.Context().Value(keyUID).(string)
	return v
}

func WithDevice(r *http.Request, d any) *http.Request {
	return r.WithContext(context.WithValue(r.Context(), keyDevice, d))
}

func Device(r *http.Request) any {
	return r.Context().Value(keyDevice)
}

func WithSecurity(r *http.Request, s any) *http.Request {
	return r.WithContext(context.WithValue(r.Context(), keySecurity, s))
}

func Security(r *http.Request) any {
	return r.Context().Value(keySecurity)
}

func WithCheckedUser(r *http.Request, u any) *http.Request {
	return r.WithContext(context.WithValue(r.Context(), keyCheckedUser, u))
}

func CheckedUser(r *http.Request) any {
	return r.Context().Value(keyCheckedUser)
}

// IsDev 由 config 包注入，避免循环依赖。
var IsDev = func() bool { return false }
