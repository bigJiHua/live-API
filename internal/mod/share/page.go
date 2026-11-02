// Package share —— API 托管的公开分享页（SSR，零 JavaScript）。
// 对应 api/src/modules/share/controller/sharePage.js（1:1 移植）：
//
//	GET  /share/diary/detail?token=…  token 模式：校验后直接拼好完整 HTML 返回
//	GET  /share/diary/detail?id=…     密码模式：返回原生 <form> 密码页
//	POST /share/diary/detail          密码模式表单提交（浏览器原生提交，无 JS）
//
// 设计要点：
//   - 页面零 JavaScript：无 <script> 标签，且 CSP `script-src 'none'` 兜底，
//     即使正文内嵌任何脚本/事件处理器也不会在访客浏览器执行。
//   - 正文为分享者本人所写（自部署单用户），不做服务端富文本消毒，按用户决策注入原文；
//     作者/心情/位置/错误提示等纯文本字段一律 htmlEscape，防止破坏页面结构。
//   - 密码防爆破复用 controller.go 的 verifyPasswordCore（同一 pwTracker、同一规则）。
//   - Cache-Control: no-store（内容随查询参数变化且属私有内容）。
package share

import (
	"fmt"
	"html"
	"net/http"
	"strconv"
	"strings"
	"time"

	"live/api/internal/tim"
)

// pageCSP 页面专用 CSP（与 Node sharePage.js 一致）：
//   - script 全禁：即使正文被注入脚本也无法执行
//   - img 放行 http/https/data（正文与九宫格可能引用外部或 base64 图）
//   - style 允许内联（页面自身 <style> 与 wangEditor 产出的 style 属性）
//   - frame-ancestors 'none'：禁止被第三方 iframe 嵌套（点击劫持）
const pageCSP = "default-src 'self'; script-src 'none'; style-src 'self' 'unsafe-inline'; " +
	"img-src 'self' data: http: https:; connect-src 'none'; base-uri 'none'; " +
	"frame-ancestors 'none'; form-action 'self'"

// writeHTML 输出页面（统一安全头；私有内容禁止缓存）。
func writeHTML(w http.ResponseWriter, status int, body string) {
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.Header().Set("Content-Security-Policy", pageCSP)
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Referrer-Policy", "no-referrer")
	w.WriteHeader(status)
	_, _ = w.Write([]byte(body))
}

const avatarSVG = `<svg class="avatar" viewBox="0 0 40 40"><rect width="40" height="40" rx="20" fill="#e8e8e8"/><circle cx="20" cy="14" r="8" fill="#c0c0c0"/><ellipse cx="20" cy="36" rx="15" ry="10" fill="#c0c0c0"/></svg>`

const lockSVG = `<svg viewBox="0 0 48 48" fill="none"><rect x="9" y="21" width="30" height="21" rx="4" fill="#1989fa" opacity="0.15"/><rect x="9" y="21" width="30" height="21" rx="4" stroke="#1989fa" stroke-width="3"/><path d="M16 21v-4a8 8 0 0 1 16 0v4" stroke="#1989fa" stroke-width="3" stroke-linecap="round"/><circle cx="24" cy="30" r="2.5" fill="#1989fa"/><path d="M24 32v4" stroke="#1989fa" stroke-width="3" stroke-linecap="round"/></svg>`

const errorSVG = `<svg viewBox="0 0 48 48" fill="none"><circle cx="24" cy="24" r="22" stroke="#dcdee0" stroke-width="3"/><path d="M24 14v14" stroke="#dcdee0" stroke-width="4" stroke-linecap="round"/><circle cx="24" cy="34.5" r="2.5" fill="#dcdee0"/></svg>`

const moodSVG = `<svg viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="9" stroke="currentColor" stroke-width="2"/><path d="M8.5 14.5c.9 1.2 2.1 1.8 3.5 1.8s2.6-.6 3.5-1.8" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><circle cx="9" cy="9.5" r="1.2" fill="currentColor"/><circle cx="15" cy="9.5" r="1.2" fill="currentColor"/></svg>`

const locationSVG = `<svg viewBox="0 0 24 24" fill="none"><path d="M12 21s-7-5.5-7-11a7 7 0 0 1 14 0c0 5.5-7 11-7 11z" stroke="currentColor" stroke-width="2"/><circle cx="12" cy="10" r="2.5" stroke="currentColor" stroke-width="2"/></svg>`

// pageStyle 页面样式（与 Node 版 detail.html 一致的紧凑样式）。
const pageStyle = `
    * { margin: 0; padding: 0; box-sizing: border-box; -webkit-tap-highlight-color: transparent; }
    html, body { min-height: 100%; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "PingFang SC", "Microsoft YaHei", sans-serif;
      background: #f5f6f7; color: #323233; font-size: 15px; line-height: 1.6;
    }
    .center-wrap { min-height: 100vh; display: flex; align-items: center; justify-content: center; padding: 24px; }
    .error-box { text-align: center; }
    .error-box svg { width: 56px; height: 56px; }
    .error-box .msg { margin-top: 12px; color: #969799; font-size: 14px; }
    .pw-card {
      background: #fff; border-radius: 12px; padding: 32px 24px; width: 100%; max-width: 360px;
      text-align: center; box-shadow: 0 2px 8px rgba(0,0,0,.06);
    }
    .pw-card svg { width: 40px; height: 40px; }
    .pw-card h3 { margin-top: 12px; font-size: 17px; font-weight: 600; }
    .pw-desc { margin-top: 6px; color: #969799; font-size: 13px; }
    #pw {
      margin-top: 20px; width: 100%; padding: 10px 0; text-align: center; font-size: 22px;
      letter-spacing: 10px; text-indent: 10px; border: none; border-bottom: 1px solid #ebedf0;
      outline: none; border-radius: 0; background: transparent; font-family: inherit;
    }
    #pw:focus { border-bottom-color: #1989fa; }
    .pw-error { margin-top: 10px; color: #ee0a24; font-size: 13px; min-height: 1px; }
    .pw-btn {
      margin-top: 20px; width: 100%; padding: 9px 0; border: none; border-radius: 20px;
      background: #1989fa; color: #fff; font-size: 15px;
    }
    .content-wrap { max-width: 560px; margin: 0 auto; padding: 16px 14px 32px; }
    .card { background: #fff; border-radius: 12px; padding: 16px; box-shadow: 0 2px 8px rgba(0,0,0,.06); }
    .header { display: flex; align-items: center; gap: 10px; }
    .avatar { width: 40px; height: 40px; border-radius: 50%; flex-shrink: 0; }
    .header-info { flex: 1; min-width: 0; }
    .author-name { font-size: 15px; font-weight: 600; }
    .time-text { margin-top: 2px; font-size: 12px; color: #c8c9cc; }
    .mood-tag {
      flex-shrink: 0; display: flex; align-items: center; gap: 3px; padding: 3px 10px;
      border-radius: 12px; background: #fff7e6; color: #fa9d3b; font-size: 12px;
    }
    .mood-tag svg { width: 13px; height: 13px; }
    .body-text { margin-top: 14px; word-break: break-word; overflow-wrap: anywhere; }
    .body-text img { max-width: 100%; height: auto; border-radius: 6px; }
    .body-text p { margin: 6px 0; }
    .body-text blockquote { margin: 8px 0; padding: 4px 12px; border-left: 3px solid #e5e6eb; color: #646566; }
    .body-text pre { margin: 8px 0; padding: 10px; background: #f7f8fa; border-radius: 6px; overflow-x: auto; font-size: 13px; }
    .body-text table { border-collapse: collapse; margin: 8px 0; max-width: 100%; }
    .body-text th, .body-text td { border: 1px solid #ebedf0; padding: 5px 10px; font-size: 14px; }
    .image-grid { margin-top: 12px; display: grid; grid-template-columns: repeat(3, 1fr); gap: 6px; }
    .image-grid.has-1 { grid-template-columns: 68%; }
    .image-grid img { width: 100%; aspect-ratio: 1; object-fit: cover; border-radius: 6px; display: block; background: #f7f8fa; }
    .location-row { margin-top: 12px; display: flex; align-items: center; gap: 4px; color: #969799; font-size: 13px; }
    .location-row svg { width: 14px; height: 14px; flex-shrink: 0; }
    .footer { margin-top: 14px; text-align: center; }
    .expire-hint { color: #c8c9cc; font-size: 12px; }
`

// pageWrap 页面骨架（noindex：私有内容禁止搜索引擎收录）。
func pageWrap(title, body string) string {
	return "<!DOCTYPE html>\n<html lang=\"zh-CN\">\n<head>\n" +
		"  <meta charset=\"UTF-8\">\n" +
		"  <meta name=\"viewport\" content=\"width=device-width, initial-scale=1.0, viewport-fit=cover\">\n" +
		"  <meta name=\"robots\" content=\"noindex, nofollow\">\n" +
		"  <title>" + htmlEscape(title) + "</title>\n" +
		"  <style>" + pageStyle + "</style>\n" +
		"</head>\n<body>\n" + body + "\n</body>\n</html>"
}

// renderErrorPage 错误页。
func renderErrorPage(message string) string {
	body := "  <div class=\"center-wrap\">\n" +
		"    <div class=\"error-box\">\n" +
		"      " + errorSVG + "\n" +
		"      <p class=\"msg\">" + htmlEscape(message) + "</p>\n" +
		"    </div>\n" +
		"  </div>"
	return pageWrap("分享详情", body)
}

// renderPasswordForm 密码模式页（原生表单，无 JS）。
func renderPasswordForm(id, errMsg string) string {
	body := "  <div class=\"center-wrap\">\n" +
		"    <div class=\"pw-card\">\n" +
		"      " + lockSVG + "\n" +
		"      <h3>需要访问密码</h3>\n" +
		"      <p class=\"pw-desc\">请输入分享者提供的 6 位数字密码</p>\n" +
		"      <form method=\"post\" action=\"/share/diary/detail\">\n" +
		"        <input type=\"hidden\" name=\"id\" value=\"" + htmlEscape(id) + "\">\n" +
		"        <input id=\"pw\" name=\"pw\" type=\"password\" inputmode=\"numeric\" pattern=\"[0-9]*\" maxlength=\"6\" autocomplete=\"off\" autofocus>\n" +
		"        <p class=\"pw-error\">" + htmlEscape(errMsg) + "</p>\n" +
		"        <button type=\"submit\" class=\"pw-btn\">验证</button>\n" +
		"      </form>\n" +
		"    </div>\n" +
		"  </div>"
	return pageWrap("分享详情", body)
}

// pageFormatTime 对应 JS formatTime：ms 时间戳 → 本地 YYYY-MM-DD HH:mm。
func pageFormatTime(v any) string {
	ms := jsMs(v)
	if ms == 0 {
		return ""
	}
	t := time.UnixMilli(ms)
	return fmt.Sprintf("%d-%02d-%02d %02d:%02d", t.Year(), int(t.Month()), t.Day(), t.Hour(), t.Minute())
}

// jsMs 宽松解析时间值：字符串/数字（ms）→ 毫秒；失败返回 0。
func jsMs(v any) int64 {
	switch t := v.(type) {
	case string:
		if n, err := strconv.ParseInt(strings.TrimSpace(t), 10, 64); err == nil {
			return n
		}
	case int64:
		return t
	case float64:
		return int64(t)
	}
	return 0
}

// pageExpireText 对应 JS expireText。
func pageExpireText(expireAt string) string {
	if expireAt == "" {
		return ""
	}
	exp, err := httpTimeParse(expireAt)
	if err != nil {
		return ""
	}
	diff := exp - tim.Now().UnixMilli()
	if diff <= 0 {
		return "已过期"
	}
	hours := diff / 3600000
	mins := (diff % 3600000) / 60000
	if hours > 24 {
		return fmt.Sprintf("分享链接 %d天后过期", hours/24)
	}
	if hours > 0 {
		return fmt.Sprintf("分享链接 %d小时后过期", hours)
	}
	return fmt.Sprintf("分享链接 %d分钟后过期", mins)
}

// httpTimeParse 解析 Node toISOString 输出（2006-01-02T15:04:05.000Z）。
func httpTimeParse(s string) (int64, error) {
	t, err := time.Parse("2006-01-02T15:04:05.000Z", s)
	if err != nil {
		// 兼容无毫秒/带时区偏移的变体
		if t2, err2 := time.Parse(time.RFC3339, s); err2 == nil {
			return t2.UnixMilli(), nil
		}
		return 0, err
	}
	return t.UnixMilli(), nil
}

// resolveImg 相对上传路径 → 同源完整 URL（绝对地址原样返回）。
func resolveImg(u string) string {
	if u == "" {
		return ""
	}
	if strings.HasPrefix(u, "http://") || strings.HasPrefix(u, "https://") {
		return u
	}
	const fileBase = "/api/public"
	if strings.HasPrefix(u, fileBase+"/") {
		return u
	}
	if strings.HasPrefix(u, "/") {
		return fileBase + u
	}
	return fileBase + "/" + u
}

// renderContentPage 内容页（data 为 buildResponse 的 data 字段；expireAt 仅 token 模式有值）。
func renderContentPage(data map[string]any, expireAt string) string {
	author := "ta"
	if a, ok := data["author"].(map[string]any); ok {
		if n := toStr(a["name"]); n != "" {
			author = n
		}
	}
	mood := ""
	if s, ok := data["mood"].(string); ok {
		mood = s
	}
	locName := ""
	if loc, ok := data["location"].(map[string]any); ok {
		locName = toStr(loc["name"])
	}

	var b strings.Builder
	b.WriteString("  <div class=\"content-wrap\">\n")
	b.WriteString("    <div class=\"card\">\n")
	b.WriteString("      <div class=\"header\">\n")
	b.WriteString("        " + avatarSVG + "\n")
	b.WriteString("        <div class=\"header-info\">\n")
	b.WriteString("          <div class=\"author-name\">" + htmlEscape(author) + "</div>\n")
	b.WriteString("          <div class=\"time-text\">" + htmlEscape(pageFormatTime(data["create_time"])) + "</div>\n")
	b.WriteString("        </div>\n")
	if mood != "" {
		b.WriteString("        <div class=\"mood-tag\">" + moodSVG + "<span>" + htmlEscape(mood) + "</span></div>\n")
	}
	b.WriteString("      </div>\n")

	// 正文：分享者本人所写，原文注入（不做服务端消毒，CSP script-src 'none' 兜底）
	content := toStr(data["content"])
	b.WriteString("      <div class=\"body-text\">" + content + "</div>\n")

	// 图片九宫格（点击新标签页打开，替代 JS 灯箱）
	if imgs, ok := data["img_url"].([]any); ok && len(imgs) > 0 {
		cls := "image-grid"
		if len(imgs) == 1 {
			cls += " has-1"
		}
		b.WriteString("      <div class=\"" + cls + "\">\n")
		for _, item := range imgs {
			url := ""
			switch t := item.(type) {
			case map[string]any:
				url = toStr(t["url"])
			case string:
				url = t
			}
			full := resolveImg(url)
			if full == "" {
				continue
			}
			b.WriteString("        <a href=\"" + htmlEscape(full) + "\" target=\"_blank\" rel=\"noopener noreferrer\"><img src=\"" + htmlEscape(full) + "\" alt=\"\" loading=\"lazy\"></a>\n")
		}
		b.WriteString("      </div>\n")
	}

	if locName != "" {
		b.WriteString("      <div class=\"location-row\">" + locationSVG + "<span>" + htmlEscape(locName) + "</span></div>\n")
	}
	b.WriteString("    </div>\n")
	if hint := pageExpireText(expireAt); hint != "" {
		b.WriteString("    <div class=\"footer\"><span class=\"expire-hint\">" + htmlEscape(hint) + "</span></div>\n")
	}
	b.WriteString("  </div>")
	return pageWrap("分享详情", b.String())
}

// PageView GET /share/diary/detail —— token / 密码模式页面。
func PageView(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	token := q.Get("token")
	id := q.Get("id")

	// ── token 模式（对齐 controller.go ViewShare 的校验分支） ──
	if token != "" {
		payload, err := verifyShareToken(token)
		if err != nil {
			writeHTML(w, http.StatusBadRequest, renderErrorPage("链接无效或已损坏"))
			return
		}
		if int64(payload.Exp) < tim.Now().UnixMilli() {
			writeHTML(w, http.StatusGone, renderErrorPage("分享链接已过期，请联系分享者重新获取"))
			return
		}
		moment, err := findMomentById(payload.Did)
		if err != nil {
			writeHTML(w, http.StatusInternalServerError, renderErrorPage("查看分享失败"))
			return
		}
		if moment == nil || truthy(moment["is_deleted"]) {
			writeHTML(w, http.StatusNotFound, renderErrorPage("内容不存在或已删除"))
			return
		}
		vis := parseVis(moment)
		if vis == nil || toF(vis["vt"]) != 1 {
			writeHTML(w, http.StatusForbidden, renderErrorPage("分享已关闭"))
			return
		}
		if toF(vis["vs"]) != payload.Vs || toStr(vis["pw"]) != payload.Pw {
			writeHTML(w, http.StatusForbidden, renderErrorPage("链接已失效，请获取最新链接"))
			return
		}
		data := buildResponse(moment)["data"].(map[string]any)
		expireAt := time.UnixMilli(int64(payload.Exp)).UTC().Format("2006-01-02T15:04:05.000Z")
		writeHTML(w, http.StatusOK, renderContentPage(data, expireAt))
		return
	}

	// ── 密码模式：渲染密码表单 ──
	if id != "" {
		writeHTML(w, http.StatusOK, renderPasswordForm(id, ""))
		return
	}

	writeHTML(w, http.StatusBadRequest, renderErrorPage("链接无效"))
}

// PageSubmit POST /share/diary/detail —— 密码表单提交。
// 复用 verifyPasswordCore（与 JSON 接口同一防爆破 tracker 和校验规则）。
func PageSubmit(w http.ResponseWriter, r *http.Request) {
	b := respParseForm(r)
	result := verifyPasswordCore(b["id"], b["pw"])

	// 🔒 status 由 verifyPasswordCore 以 int 写入（toF 不处理 int），此处必须类型断言判断
	if st, ok := result["status"].(int); ok && st == 200 {
		data, _ := result["data"].(map[string]any)
		writeHTML(w, http.StatusOK, renderContentPage(data, ""))
		return
	}

	msg := toStr(result["message"])
	if msg == "" {
		msg = "验证失败"
	}
	writeHTML(w, http.StatusOK, renderPasswordForm(toStr(b["id"]), msg))
}

// respParseForm 解析表单提交（urlencoded）：
// BodyLoader 会把原始 body 回填到 r.Body，ParseForm 可重复读取。
func respParseForm(r *http.Request) map[string]any {
	out := map[string]any{}
	if ct := r.Header.Get("Content-Type"); strings.Contains(ct, "application/x-www-form-urlencoded") {
		if err := r.ParseForm(); err == nil {
			for k, v := range r.PostForm {
				if len(v) > 0 {
					out[k] = v[0]
				}
			}
			return out
		}
	}
	return out
}

// htmlEscape 对应 JS escapeHtml（Go html.EscapeString 语义一致：& < > " '）。
func htmlEscape(s string) string { return html.EscapeString(s) }
