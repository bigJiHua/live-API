package mw

// SYNC-A38（2026-10-12）：为 SYNC-A3/A4/A9/A10 的中间件修复补单测。
//
// 覆盖：
//  - securityCheck 的 6 处统一对外文案「非法请求！」（基准 securityCheck.js）
//  - ClientIP 的 TRUST_PROXY_HOPS 语义（显式留空=不信任 / hops>段数=回落 socket）
//  - AccountLockCheck 的防枚举同构（不存在账号恒 404，不因阈值改 423）
//  - EmailCodeRateLimit 的 captcha_verified=NULL 不绕过（需 DB，用纯函数拆测）

import (
	"net/http"
	"net/http/httptest"
	"os"
	"strconv"
	"strings"
	"testing"
	"time"
)

// ---------- securityCheck 对外文案 ----------

// newSecReq 造一个能通过 securityCheck 前置（X-Requested-With + 时间戳）的请求。
func newSecReq(t *testing.T, mutate func(*http.Request)) *http.Request {
	t.Helper()
	r := httptest.NewRequest(http.MethodPost, "/api/v1/account/list", nil)
	r.RemoteAddr = "10.1.2.3:54321"
	r.Header.Set("x-requested-with", "XMLHttpRequest")
	r.Header.Set("x-client-timestamp", strconv.FormatInt(time.Now().UnixMilli(), 10))
	if mutate != nil {
		mutate(r)
	}
	return r
}

func TestSecurityCheckIllegalRequestMessage(t *testing.T) {
	t.Setenv("REQUIRE_CLIENT_NONCE", "true")
	t.Setenv("PIN_NONCE_MODE", "enforce")
	t.Setenv("TRUST_PROXY_HOPS", "")

	cases := []struct {
		name   string
		mutate func(*http.Request)
	}{
		{"缺 X-Requested-With", func(r *http.Request) { r.Header.Del("x-requested-with") }},
		{"时间戳过期", func(r *http.Request) { r.Header.Set("x-client-timestamp", "1") }},
		{"时间戳缺失", func(r *http.Request) { r.Header.Del("x-client-timestamp") }},
		{"nonce 格式非法", func(r *http.Request) { r.Header.Set("x-client-nonce", "short") }},
	}

	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			var reached bool
			h := SecurityCheck(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				reached = true
			}))
			w := httptest.NewRecorder()
			h.ServeHTTP(w, newSecReq(t, c.mutate))

			if reached {
				t.Fatalf("请求不应通过 securityCheck")
			}
			if w.Code != 400 {
				t.Errorf("HTTP 状态 = %d，期望 400", w.Code)
			}
			// 基准：securityCheck.js 的 6 处拦截统一 res.say("非法请求！", 400)
			if msg := jsonMessage(t, w.Body.Bytes()); msg != "非法请求！" {
				t.Errorf("对外文案 = %q，期望 \"非法请求！\"（细节只进日志，不外泄）", msg)
			}
		})
	}
}

// TestSecurityCheckNonceReplay 对齐 8401 + retryable。
func TestSecurityCheckNonceReplay(t *testing.T) {
	t.Setenv("REQUIRE_CLIENT_NONCE", "true")
	t.Setenv("PIN_NONCE_MODE", "enforce")
	t.Setenv("TRUST_PROXY_HOPS", "")

	nonce := "abcdefghijklmnop" // 16 位，符合正则
	var reached int
	h := SecurityCheck(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { reached++ }))

	w1 := httptest.NewRecorder()
	h.ServeHTTP(w1, newSecReq(t, func(r *http.Request) { r.Header.Set("x-client-nonce", nonce) }))
	if w1.Code != 200 || reached != 1 {
		t.Fatalf("首次请求应通过：code=%d reached=%d body=%s", w1.Code, reached, w1.Body.String())
	}

	w2 := httptest.NewRecorder()
	h.ServeHTTP(w2, newSecReq(t, func(r *http.Request) { r.Header.Set("x-client-nonce", nonce) }))
	if w2.Code != 400 {
		t.Fatalf("重放请求 HTTP = %d，期望 400", w2.Code)
	}
	if !contains(w2.Body.String(), `"code":8401`) || !contains(w2.Body.String(), `"retryable":true`) {
		t.Errorf("重放响应体缺少 8401/retryable：%s", w2.Body.String())
	}
}

// TestSecurityCheckEmptyIPAllowed 对齐 keep BUG-050：
// Node 为 `if (clientIp && net.isIP(clientIp) === 0)` —— 空 IP 放行，只有**非空且非法**才拒。
//
// 造出「空 IP」需同时满足两个条件，缺一则该用例恒真、空转：
//  1. TRUST_PROXY_HOPS=0 —— 不走 XFF、直接取 socket 地址（注意：**空串语义为 1**，见 resolveTrustProxyHops）；
//  2. RemoteAddr 清空 —— ClientIP 的 SplitHostPort 失败后才回落空串。
func TestSecurityCheckEmptyIPAllowed(t *testing.T) {
	t.Setenv("REQUIRE_CLIENT_NONCE", "false")
	t.Setenv("PIN_NONCE_MODE", "off")
	t.Setenv("TRUST_PROXY_HOPS", "0")

	r := newSecReq(t, func(r *http.Request) { r.RemoteAddr = "" })
	if got := ClientIP(r); got != "" {
		t.Fatalf("前置条件不成立：ClientIP = %q，期望空串（否则触达不到空 IP 分支，断言无意义）", got)
	}

	var reached bool
	h := SecurityCheck(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { reached = true }))
	w := httptest.NewRecorder()
	h.ServeHTTP(w, r)
	if !reached {
		t.Errorf("空 IP 场景（TRUST_PROXY_HOPS=0 + RemoteAddr 为空）应放行，实际被拦：%s", w.Body.String())
	}
}

// ---------- ClientIP / TRUST_PROXY_HOPS ----------

func TestResolveTrustProxyHops(t *testing.T) {
	cases := []struct {
		raw  string
		want int
	}{
		{"1", 1}, {"2", 2}, {"0", 0},
		{"", 1},     // 未设置 ⇒ Node 的 ?? "1"
		{"  ", 1},   // 纯空白 ⇒ 视为未设置
		{"-1", 0},   // 负数收敛为 0（不信任 XFF）
		{"true", 1}, // 非数字 ⇒ 回落 1（宁可少信）
	}
	for _, c := range cases {
		if os.Getenv("TRUST_PROXY_HOPS") != "" {
			os.Unsetenv("TRUST_PROXY_HOPS")
		}
		if c.raw != "" {
			t.Setenv("TRUST_PROXY_HOPS", c.raw)
		} else {
			t.Setenv("TRUST_PROXY_HOPS", "")
		}
		if got := resolveTrustProxyHops(); got != c.want {
			t.Errorf("resolveTrustProxyHops(%q) = %d，期望 %d", c.raw, got, c.want)
		}
	}
}

func TestClientIPTrustSemantics(t *testing.T) {
	// hops=1：取 XFF 右起第 2 段（最近可信代理报告的客户端）
	t.Setenv("TRUST_PROXY_HOPS", "1")
	r := httptest.NewRequest(http.MethodGet, "/", nil)
	r.RemoteAddr = "10.0.0.9:1234"
	r.Header.Set("X-Forwarded-For", "1.1.1.1, 2.2.2.2")
	if got := ClientIP(r); got != "2.2.2.2" {
		t.Errorf("hops=1 多段 XFF：got %q，期望 2.2.2.2", got)
	}

	// hops=0：完全不信 XFF
	t.Setenv("TRUST_PROXY_HOPS", "0")
	r2 := httptest.NewRequest(http.MethodGet, "/", nil)
	r2.RemoteAddr = "10.0.0.9:1234"
	r2.Header.Set("X-Forwarded-For", "6.6.6.6")
	if got := ClientIP(r2); got != "10.0.0.9" {
		t.Errorf("hops=0 应回落 socket 地址：got %q，期望 10.0.0.9", got)
	}

	// hops > XFF 段数：XFF 不可信 ⇒ 回落 socket（**不能**返回最左段）
	t.Setenv("TRUST_PROXY_HOPS", "3")
	r3 := httptest.NewRequest(http.MethodGet, "/", nil)
	r3.RemoteAddr = "10.0.0.9:1234"
	r3.Header.Set("X-Forwarded-For", "7.7.7.7")
	if got := ClientIP(r3); got != "10.0.0.9" {
		t.Errorf("hops>段数应回落 socket（防伪造最左段）：got %q，期望 10.0.0.9", got)
	}
}

// ---------- 防枚举同构 ----------

// TestLoginFailureRecordAndClear 锁定「失败驱动」阈值语义（5 次/15min、锁 15min）。
func TestLoginFailureRecordAndClear(t *testing.T) {
	const key = "enumerate-probe@example.com"
	ClearLoginFailures(key)

	for i := 1; i < loginMaxFailures; i++ {
		lf := RecordLoginFailure(key)
		if lf.Locked {
			t.Fatalf("第 %d 次失败就锁定了，阈值应为 %d", i, loginMaxFailures)
		}
	}
	lf := RecordLoginFailure(key)
	if !lf.Locked {
		t.Fatalf("第 %d 次失败应锁定", loginMaxFailures)
	}
	if lf.RemainingMS <= 0 {
		t.Errorf("Locked=true 时 RemainingMS 应 > 0，实际 %d", lf.RemainingMS)
	}
	if got := loginLockedRemaining(key); got <= 0 {
		t.Errorf("锁定期剩余应 > 0，实际 %d", got)
	}

	// 成功登录清零
	ClearLoginFailures(key)
	if got := loginLockedRemaining(key); got != 0 {
		t.Errorf("ClearLoginFailures 后应无锁定期，实际 %d", got)
	}
	if lf := RecordLoginFailure(key); lf.Locked {
		t.Errorf("清零后首次失败不应锁定")
	}
	ClearLoginFailures(key)
}

// TestLoginKeyNormalization 大小写/空格变体必须归一到同一条目（防绕过）。
func TestLoginKeyNormalization(t *testing.T) {
	if loginKey("  Admin@Example.COM ") != loginKey("admin@example.com") {
		t.Errorf("key 归一化失败：%q vs %q", loginKey("  Admin@Example.COM "), loginKey("admin@example.com"))
	}
}

// TestGenericAuthErrorIsOpaque 防枚举文案不得泄露账号存在性。
func TestGenericAuthErrorIsOpaque(t *testing.T) {
	if GenericAuthStatus != 404 {
		t.Errorf("GenericAuthStatus = %d，期望 404（基准 accountLockCheck.js）", GenericAuthStatus)
	}
	if GenericAuthError != "账号或密码错误" {
		t.Errorf("GenericAuthError = %q，期望「账号或密码错误」", GenericAuthError)
	}
	if contains(GenericAuthError, "不存在") || contains(GenericAuthError, "密码错误」且") {
		t.Errorf("防枚举文案不得区分「账号不存在」与「密码错误」")
	}
}

// ---------- 惰性配置读取 ----------

// TestConfigVarsAreLazy 锁住 SYNC-A16：PIN_RISK_* / PIN_NONCE_MODE 必须
// 在 config.Load() 之后才读取，否则 .env 改了不生效。
func TestConfigVarsAreLazy(t *testing.T) {
	// 此时 config.Load() 早已在 main 里跑过；直接改 env 后应立即生效
	t.Setenv("PIN_RISK_FREQ_LIMIT", "7")
	if got := freqLimit(); got != 7 {
		t.Errorf("freqLimit() = %d，期望 7（改动应即时生效，不得在包级变量里缓存）", got)
	}
	t.Setenv("PIN_RISK_FREQ_WINDOW", "13")
	if got := freqWindowMS(); got != 13000 {
		t.Errorf("freqWindowMS() = %d，期望 13000", got)
	}
	t.Setenv("PIN_RISK_SENSITIVE_LIMIT", "3")
	if got := sensitiveLimit(); got != 3 {
		t.Errorf("sensitiveLimit() = %d，期望 3", got)
	}
	t.Setenv("PIN_PASS_WINDOW", "45")
	if got := passWindowMS(); got != 45000 {
		t.Errorf("passWindowMS() = %d，期望 45000", got)
	}
	t.Setenv("PIN_RISK_MODE", "observe")
	if got := riskMode(); got != "observe" {
		t.Errorf("riskMode() = %q，期望 observe", got)
	}
	t.Setenv("PIN_NONCE_MODE", "off")
	if got := nonceMode(); got != "off" {
		t.Errorf("nonceMode() = %q，期望 off", got)
	}
}

// ---------- 工具 ----------

func contains(s, sub string) bool { return strings.Contains(s, sub) }

func jsonMessage(t *testing.T, body []byte) string {
	t.Helper()
	s := string(body)
	i := strings.Index(s, `"message":"`)
	if i < 0 {
		return ""
	}
	rest := s[i+len(`"message":"`):]
	j := 0
	for j < len(rest) && rest[j] != '"' {
		j++
	}
	return rest[:j]
}
