package resp

// SYNC-A38（2026-10-12）：锁定响应契约 —— 这是 Node ↔ Go 端行为对齐的基石。
//
// app.js:153-170 的 res.say：
//   - HTTP 状态 = 传入的 status（缺省 206）
//   - body = { status, message }（status 为 undefined 时该键被 JSON.stringify 省略）
//   - 5xx 且非 development ⇒ message 脱敏为「服务器内部错误」
//
// authGuard 的怪癖：无 token 返回 **HTTP 200 + body{status:401}**，必须保留。

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestSayDefaultStatusIs206(t *testing.T) {
	w := httptest.NewRecorder()
	Say(w, "操作成功", 0)

	if w.Code != 206 {
		t.Errorf("res.say 未指定状态时 HTTP = %d，期望 206（基准 app.js:155）", w.Code)
	}
	var body map[string]any
	if err := json.Unmarshal(w.Body.Bytes(), &body); err != nil {
		t.Fatalf("body 非 JSON：%s", w.Body.String())
	}
	if body["message"] != "操作成功" {
		t.Errorf("message = %v", body["message"])
	}
	// status 键在 Node 的 undefined 场景应被省略
	if _, has := body["status"]; has {
		t.Errorf("status 为 undefined 时不应出现在 body 中，实际 %s", w.Body.String())
	}
}

func TestSayWithExplicitStatus(t *testing.T) {
	w := httptest.NewRecorder()
	Say(w, "已退出登录", 200)

	if w.Code != 200 {
		t.Errorf("HTTP = %d，期望 200", w.Code)
	}
	var body map[string]any
	_ = json.Unmarshal(w.Body.Bytes(), &body)
	if body["status"] != float64(200) {
		t.Errorf("body.status = %v，期望 200", body["status"])
	}
	if body["message"] != "已退出登录" {
		t.Errorf("body.message = %v", body["message"])
	}
}

func TestSay423LockedShape(t *testing.T) {
	w := httptest.NewRecorder()
	JSON(w, 423, map[string]any{
		"status": 423, "message": "登录失败次数过多，请 900 秒后重试", "locked": true,
	})
	if w.Code != 423 {
		t.Errorf("HTTP = %d，期望 423", w.Code)
	}
	if !strings.Contains(w.Body.String(), `"locked":true`) {
		t.Errorf("423 响应缺 locked 字段：%s", w.Body.String())
	}
}

// TestJSONHTTP200WithBody401 怪癖必须保留：authGuard 无 token 时 HTTP 200 + body{status:401}。
func TestJSONHTTP200WithBody401(t *testing.T) {
	w := httptest.NewRecorder()
	JSON(w, 200, map[string]any{"status": 401, "message": "未登录"})

	if w.Code != 200 {
		t.Errorf("HTTP = %d，期望 200（怪癖：HTTP 200 携带 body 401）", w.Code)
	}
	var body map[string]any
	_ = json.Unmarshal(w.Body.Bytes(), &body)
	if body["status"] != float64(401) {
		t.Errorf("body.status = %v，期望 401", body["status"])
	}
}

func TestJSONNotFoundStructure(t *testing.T) {
	w := httptest.NewRecorder()
	JSON(w, 404, map[string]any{"code": 404, "message": "非法访问: GET /x！"})

	if w.Code != 404 {
		t.Errorf("HTTP = %d，期望 404", w.Code)
	}
	var body map[string]any
	_ = json.Unmarshal(w.Body.Bytes(), &body)
	if body["code"] != float64(404) {
		t.Errorf("body.code = %v（前端按 code 判错分支，缺了会 undefined）", body["code"])
	}
}

// TestJSONStripsErrorInProduction 对齐 buildErrorBody 的生产脱敏（SYNC-004）。
func TestJSONStripsErrorInProduction(t *testing.T) {
	orig := IsDev
	IsDev = func() bool { return false } // 生产
	defer func() { IsDev = orig }()

	w := httptest.NewRecorder()
	JSON(w, 500, map[string]any{"message": "查询失败", "error": "Error 1146: Table 'x' doesn't exist"})
	if strings.Contains(w.Body.String(), "doesn't exist") {
		t.Errorf("生产环境不得回显内部错误细节：%s", w.Body.String())
	}

	// dev 保留便于调试
	IsDev = func() bool { return true }
	w2 := httptest.NewRecorder()
	JSON(w2, 500, map[string]any{"message": "查询失败", "error": "boom"})
	if !strings.Contains(w2.Body.String(), "boom") {
		t.Errorf("dev 环境应保留 error 字段：%s", w2.Body.String())
	}
}

// TestBodyParseDataFallback 对应 Node 的 `req.body.data.X`。
//
// 🔒 SYNC-A44（2026-10-13）**订正本用例原先的错误断言**：
// 原注释写「缺 data 时回落顶层（与 Node 的 || 语义一致）」—— 那是误解。
// Node accountLockCheck.js:147 是 `const { nameOrEmail } = req.body.data || {}`，
// `|| {}` 的意思是「data 缺失就换成空对象」，**不是**「回退去读顶层」。
// 于是 Node 对 `{"nameOrEmail":"admin"}`（顶层）取到 undefined → 401。
//
// 旧 Go 的 lookup 剥掉 "data." 前缀后回落 Raw，等于凭空造出一条
// 「顶层也能当 data 用」的通道（表单编码登录同理）⇒ 安全差异。已修正为不回落。
func TestBodyParseDataFallback(t *testing.T) {
	req := httptest.NewRequest(http.MethodPost, "/api/v1/auth/login",
		strings.NewReader(`{"data":{"nameOrEmail":"admin","password":"x"}}`))
	b := Parse(req)

	if got := b.Str("data.nameOrEmail"); got != "admin" {
		t.Errorf("b.Str(data.nameOrEmail) = %q，期望 admin", got)
	}
	if b.Data == nil {
		t.Fatalf("b.Data 未解析")
	}

	// 🔒 data 缺失时，data. 前缀的取值恒为空（对齐 Node），**不回落顶层**
	req2 := httptest.NewRequest(http.MethodPost, "/api/v1/x",
		strings.NewReader(`{"nameOrEmail":"admin"}`))
	b2 := Parse(req2)
	if got := b2.Str("data.nameOrEmail"); got != "" {
		t.Errorf("data 缺失时 data.nameOrEmail 应为空（Node 取 undefined），got %q", got)
	}
	// 无 data. 前缀时维持原有回落行为（顶层键仍可取）
	if got := b2.Str("nameOrEmail"); got != "admin" {
		t.Errorf("顶层键应仍可取，got %q", got)
	}
}

// TestParseEmptyBody 空 body 不 panic。
func TestParseEmptyBody(t *testing.T) {
	req := httptest.NewRequest(http.MethodGet, "/api/v1/x", nil)
	b := Parse(req)
	if b.Str("data.anything") != "" {
		t.Errorf("空 body 应返回空串")
	}
	if b.Map("data") != nil {
		t.Errorf("空 body 的 Map 应为 nil")
	}
}

// TestBodyTypeCoercion JS 语义：字符串数字可转数值。
func TestBodyTypeCoercion(t *testing.T) {
	req := httptest.NewRequest(http.MethodPost, "/api/v1/x",
		strings.NewReader(`{"data":{"n":"12.5","i":"7","b":"true","b2":1,"s":"x"}}`))
	b := Parse(req)

	if f, ok := b.Float("data.n"); !ok || f != 12.5 {
		t.Errorf("Float(字符串数字) = %v/%v", f, ok)
	}
	if i, ok := b.Int("data.i"); !ok || i != 7 {
		t.Errorf("Int(字符串数字) = %v/%v", i, ok)
	}
	if !b.Bool("data.b") {
		t.Errorf("Bool(\"true\") 应为 true")
	}
	if !b.Bool("data.b2") {
		t.Errorf("Bool(1) 应为 true")
	}
	if b.Bool("data.s") {
		t.Errorf("Bool(\"x\") 应为 false")
	}
}
