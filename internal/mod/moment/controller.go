package moment

import (
	"encoding/json"
	"fmt"
	"math"
	"net/http"
	"regexp"
	"strconv"
	"strings"
	"time"
	"unicode/utf16"

	"live/api/internal/config"
	"live/api/internal/db"
	"live/api/internal/mw"
	"live/api/internal/resp"
	"live/api/internal/sec"
)

// ============================================================================
// 动态日记控制器 —— from: controller/index.js（逐函数复刻）
// ============================================================================

// tagRe 对应 content.replace(/<[^>]*>/g, ”)（去 HTML 标签）。
var tagRe = regexp.MustCompile(`<[^>]*>`)

// ParseFields 对应 MomentController._parseFields。
// JSON.parse 失败时返回 error（Node 中异常冒泡到调用方 catch → 500）。
// from: controller/index.js:10-39
func parseFields(item map[string]any) (map[string]any, error) {
	if item == nil {
		return nil, nil
	}

	// children：字符串按 "," 拆分去空；数组原样；其余 → []
	childIds := []any{}
	if v, ok := item["children"]; ok && v != nil {
		switch t := v.(type) {
		case string:
			for _, s := range strings.Split(t, ",") {
				if s != "" {
					childIds = append(childIds, s)
				}
			}
		case []any:
			childIds = t
		}
	}

	out := mergeKV(item, nil)
	out["children"] = childIds

	// img_url: item.img_url ? JSON.parse(item.img_url) : []
	out["img_url"] = []any{}
	if truthy(item["img_url"]) {
		parsed, err := jsonParse(toStr(item["img_url"]))
		if err != nil {
			return nil, err
		}
		out["img_url"] = parsed
	}

	// mood: item.mood ? JSON.parse(item.mood) : null
	out["mood"] = nil
	if truthy(item["mood"]) {
		parsed, err := jsonParse(toStr(item["mood"]))
		if err != nil {
			return nil, err
		}
		out["mood"] = parsed
	}

	// location: item.location ? JSON.parse(item.location) : null
	out["location"] = nil
	if truthy(item["location"]) {
		parsed, err := jsonParse(toStr(item["location"]))
		if err != nil {
			return nil, err
		}
		out["location"] = parsed
	}

	// visible_type: 兼容旧 tinyint 值（解析出数字 → {vt, vs:0, pw:0}）
	vt, err := parseVisibleType(item["visible_type"])
	if err != nil {
		return nil, err
	}
	out["visible_type"] = vt

	return out, nil
}

// jsonParse JSON.parse 包装（UseNumber 保持数字精度）。
func jsonParse(s string) (any, error) {
	dec := json.NewDecoder(strings.NewReader(s))
	dec.UseNumber()
	var v any
	if err := dec.Decode(&v); err != nil {
		return nil, err
	}
	return v, nil
}

// parseVisibleType 对应 _parseFields 的 visible_type IIFE：
// 空 → {vt:0,vs:0,pw:0}；解析出数字 → {vt, vs:0, pw:0}（兼容旧 tinyint）；
// 解析失败 → {vt:0,vs:0,pw:0}。
func parseVisibleType(v any) (any, error) {
	if !truthy(v) {
		return map[string]any{"vt": 0, "vs": 0, "pw": 0}, nil
	}
	s, ok := v.(string)
	if !ok {
		return v, nil
	}
	parsed, err := jsonParse(s)
	if err != nil {
		return map[string]any{"vt": 0, "vs": 0, "pw": 0}, nil // catch → fallback
	}
	if num, ok := parsed.(json.Number); ok {
		f, err := num.Float64()
		if err == nil {
			return map[string]any{"vt": f, "vs": 0, "pw": 0}, nil
		}
	}
	return parsed, nil
}

// Create 【创建】。from: controller/index.js:42-64
func Create(w http.ResponseWriter, r *http.Request) {
	uid := resp.UID(r)
	b := resp.Parse(r)
	d := b.DataOrRaw()

	content, _ := d["content"]
	todayMain, err := findTodayMain(db.DB(), uid)
	if err != nil {
		resp.JSON(w, 500, map[string]any{"status": 500, "message": "发布失败"})
		return
	}
	parentID := ""
	if todayMain != nil {
		parentID = toStr(todayMain["id"])
	}

	id, err := momentCreate(db.DB(), uid, parentID,
		orEmpty(content),
		jsonStringOrNull(d["images"]),
		jsonStringOrNull(d["mood"]),
		jsonStringOrNull(d["location"]),
		jsonStringOr(d["visibleType"], `{"vt":0,"vs":0,"pw":0}`),
	)
	if err != nil {
		resp.JSON(w, 500, map[string]any{"status": 500, "message": "发布失败"})
		return
	}
	resp.JSON(w, 200, map[string]any{"status": 200, "message": "发布成功", "id": id})
}

// List 【列表】。from: controller/index.js:67-84
func List(w http.ResponseWriter, r *http.Request) {
	uid := resp.UID(r)
	q := r.URL.Query()
	page := jsParseFloat(orDefault(q, "page", "1"))
	pageSize := jsParseFloat(orDefault(q, "pageSize", "10"))

	list, total, err := findByUser(db.DB(), uid, page, pageSize)
	if err != nil {
		resp.JSON(w, 500, map[string]any{"status": 500, "message": "查询失败"})
		return
	}

	parsed := make([]map[string]any, 0, len(list))
	for _, item := range list {
		p, err := parseFields(item)
		if err != nil {
			resp.JSON(w, 500, map[string]any{"status": 500, "message": "查询失败"})
			return
		}
		stripped := ""
		if c, ok := p["content"].(string); ok && c != "" {
			stripped = tagRe.ReplaceAllString(c, "")
		}
		p["content"] = jsSubstring(stripped, 0, 20)
		parsed = append(parsed, p)
	}

	resp.JSON(w, 200, map[string]any{
		"status": 200,
		"data": map[string]any{
			"list":       parsed,
			"total":      total,
			"page":       nanOrNil(page),
			"pageSize":   nanOrNil(pageSize),
			"totalPages": totalPages(total, pageSize),
		},
	})
}

// Today 【今日】。from: controller/index.js:87-100
func Today(w http.ResponseWriter, r *http.Request) {
	uid := resp.UID(r)
	moments, err := findTodayWithChildren(db.DB(), uid)
	if err != nil {
		resp.JSON(w, 500, map[string]any{"status": 500, "message": "查询今日动态失败"})
		return
	}

	data := make([]map[string]any, 0, len(moments))
	for _, parent := range moments {
		p, err := parseFields(parent)
		if err != nil {
			resp.JSON(w, 500, map[string]any{"status": 500, "message": "查询今日动态失败"})
			return
		}
		childrenData := []map[string]any{}
		if kids, ok := parent["children_data"].([]map[string]any); ok {
			for _, child := range kids {
				cp, err := parseFields(child)
				if err != nil {
					resp.JSON(w, 500, map[string]any{"status": 500, "message": "查询今日动态失败"})
					return
				}
				childrenData = append(childrenData, cp)
			}
		}
		p["children_data"] = childrenData
		data = append(data, p)
	}
	resp.JSON(w, 200, map[string]any{"status": 200, "data": data})
}

// Detail 【详情】。from: controller/index.js:103-113
func Detail(w http.ResponseWriter, r *http.Request) {
	uid := resp.UID(r)
	id := r.PathValue("id")

	m, err := findById(db.DB(), id)
	if err != nil {
		resp.JSON(w, 500, map[string]any{"status": 500, "message": "详情查询失败"})
		return
	}
	if m == nil || toStr(m["user_id"]) != uid {
		resp.JSON(w, 404, map[string]any{"message": "未找到"})
		return
	}
	parsed, err := parseFields(m)
	if err != nil {
		resp.JSON(w, 500, map[string]any{"status": 500, "message": "详情查询失败"})
		return
	}
	resp.JSON(w, 200, map[string]any{"status": 200, "data": parsed})
}

// BatchDetail 【批量详情】。from: controller/index.js:116-127
func BatchDetail(w http.ResponseWriter, r *http.Request) {
	uid := resp.UID(r)
	b := resp.Parse(r)
	d := b.DataOrRaw()

	raw, exists := d["ids"]
	// Node: !ids || !ids.length → { status: 200, data: [] }
	if !exists || raw == nil {
		resp.JSON(w, 200, map[string]any{"status": 200, "data": []any{}})
		return
	}
	if s, ok := raw.(string); ok && s == "" {
		resp.JSON(w, 200, map[string]any{"status": 200, "data": []any{}})
		return
	}
	ids, ok := raw.([]any)
	if !ok {
		// 非数组（Node: ids.map is not a function → TypeError → catch 500）
		resp.JSON(w, 500, map[string]any{"status": 500, "message": "批量查询失败"})
		return
	}

	moments, err := findByIds(db.DB(), ids, uid)
	if err != nil {
		resp.JSON(w, 500, map[string]any{"status": 500, "message": "批量查询失败"})
		return
	}
	data := make([]map[string]any, 0, len(moments))
	for _, item := range moments {
		p, err := parseFields(item)
		if err != nil {
			resp.JSON(w, 500, map[string]any{"status": 500, "message": "批量查询失败"})
			return
		}
		data = append(data, p)
	}
	resp.JSON(w, 200, map[string]any{"status": 200, "data": data})
}

// Update 通用更新（shareAction 分流到分享开关）。from: controller/index.js:130-164
func Update(w http.ResponseWriter, r *http.Request) {
	uid := resp.UID(r)
	id := r.PathValue("id")
	b := resp.Parse(r)
	d := b.DataOrRaw()

	// 分享相关 → 独立方法
	if shareAction, ok := d["shareAction"].(string); ok &&
		(shareAction == "open" || shareAction == "close" || shareAction == "token") {
		handleShareAction(w, id, uid, shareAction, d["shareDuration"])
		return
	}

	updates := map[string]any{}
	if v, ok := d["content"]; ok {
		updates["content"] = v
	}
	if v, ok := d["images"]; ok {
		updates["imgUrl"] = jsonStringOrNull(v)
	}
	if v, ok := d["mood"]; ok {
		updates["mood"] = jsonStringOrNull(v)
	}
	if v, ok := d["location"]; ok {
		updates["location"] = jsonStringOrNull(v)
	}
	if v, ok := d["visibleType"]; ok {
		// Node: visibleType !== undefined → JSON.stringify(visibleType)（null → null）
		updates["visibleType"] = jsonStringifyOrNull(v)
	}

	result := update(db.DB(), id, uid, updates)
	resp.JSON(w, statusOr(result["status"]), result)
}

// Delete 删除动态。from: controller/index.js:167-176
func Delete(w http.ResponseWriter, r *http.Request) {
	uid := resp.UID(r)
	id := r.PathValue("id")

	result := delete(db.DB(), id, uid)
	resp.JSON(w, statusOr(result["status"]), result)
}

// handleShareAction 分享开关（open/close/token）。from: controller/index.js:191-276
func handleShareAction(w http.ResponseWriter, id, userID, action string, duration any) {
	// 权限校验
	current, err := findById(db.DB(), id)
	if err != nil {
		resp.JSON(w, 500, map[string]any{"status": 500, "message": "分享操作失败"})
		return
	}
	if current == nil || toStr(current["user_id"]) != userID {
		resp.JSON(w, 404, map[string]any{"status": 404, "message": "未找到"})
		return
	}

	// 解析当前 visible_type（try/catch 兜底 {vt:0,vs:0,pw:0}）
	curVis := parseShareVisible(current["visible_type"])

	shareURL := config.Get("FRONTEND_URL", "") + "/share/diary/detail"
	expireHours := jsNumberOr(duration, 1)

	switch action {
	case "open":
		// ── 开启分享 ──
		newVs := 1
		if toF(curVis["vs"]) != 0 {
			newVs = int(toF(curVis["vs"])) + 1
		}
		// fix BUG-008：Math.random 6 位密码 → sec.Digits6（密码学随机）
		newPw := sec.Digits6()

		newVis := map[string]any{"vt": 1, "vs": newVs, "pw": newPw}
		token, terr := generateShareToken(id, newVs, newPw, expireHours)
		if terr != nil {
			resp.JSON(w, 500, map[string]any{"status": 500, "message": "分享操作失败"})
			return
		}

		update(db.DB(), id, userID, map[string]any{"visibleType": mustJSON(newVis)})

		resp.JSON(w, 200, map[string]any{
			"status":  200,
			"message": "分享已开启",
			"share": map[string]any{
				"token":       token,
				"password":    newPw,
				"tokenUrl":    shareURL + "?token=" + urlQueryEscape(token),
				"pwUrl":       shareURL + "?id=" + id,
				"expireHours": expireHours,
			},
		})

	case "token":
		// ── 刷新 token（不改变密码/版本号） ──
		if toF(curVis["vt"]) != 1 {
			resp.JSON(w, 200, map[string]any{"status": 403, "message": "分享未开启"})
			return
		}
		token, terr := generateShareToken(id, int(toF(curVis["vs"])), toStr(curVis["pw"]), expireHours)
		if terr != nil {
			resp.JSON(w, 500, map[string]any{"status": 500, "message": "分享操作失败"})
			return
		}
		resp.JSON(w, 200, map[string]any{
			"status":  200,
			"message": "Token 已生成",
			"share": map[string]any{
				"token":       token,
				"tokenUrl":    shareURL + "?token=" + urlQueryEscape(token),
				"expireHours": expireHours,
			},
		})

	case "close":
		// ── 关闭分享 ──
		newVis := map[string]any{"vt": 0, "vs": curVis["vs"], "pw": 0}
		update(db.DB(), id, userID, map[string]any{"visibleType": mustJSON(newVis)})
		resp.JSON(w, 200, map[string]any{"status": 200, "message": "分享已关闭"})
	}
}

// parseShareVisible 对应 handleShareAction 内的 curVis 解析：
// 字符串 → JSON.parse（失败兜底默认 {vt:0,vs:0,pw:0}）；其余取默认。
func parseShareVisible(v any) map[string]any {
	def := map[string]any{"vt": 0, "vs": 0, "pw": 0}
	if s, ok := v.(string); ok {
		parsed, err := jsonParse(s)
		if err != nil {
			return def
		}
		if m, ok := parsed.(map[string]any); ok {
			return m
		}
	}
	return def
}

// ===== 分享 token（对应 common/utils/shareToken.js，AES-256-GCM，key=sha256(SECRET)） =====

// generateShareToken 构造 payload JSON {did, vs, pw, exp(ms)} 并加密。
// from: common/utils/shareToken.js:14-32（secret 经 mw.ShareSecret()：SHARE_TOKEN_SECRET 回退 JWT_SECRET）
func generateShareToken(diaryID string, vs int, pw string, expireHours int) (string, error) {
	payload := fmt.Sprintf(
		`{"did":%s,"vs":%d,"pw":%s,"exp":%d}`,
		jsonString(diaryID), vs, jsonString(pw),
		time.Now().UnixMilli()+int64(expireHours)*3600*1000,
	)
	return sec.GenerateShareToken(mw.ShareSecret(), payload)
}

// ===== 通用小工具 =====

func statusOr(v any) int {
	switch t := v.(type) {
	case int:
		if t == 0 {
			return 200
		}
		return t
	case float64:
		if t == 0 {
			return 200
		}
		return int(t)
	case int64:
		if t == 0 {
			return 200
		}
		return int(t)
	}
	return 200
}

// totalPages 对应 Math.ceil(total / pageSize)（Infinity/NaN → JSON null）。
func totalPages(total int64, pageSize float64) any {
	if isNaN(pageSize) || pageSize == 0 {
		return nil
	}
	return math.Ceil(float64(total) / pageSize)
}

// nanOrNil NaN / Inf → nil（对应 JS JSON 序列化 NaN/Infinity → null）。
func nanOrNil(f float64) any {
	if math.IsNaN(f) || math.IsInf(f, 0) {
		return nil
	}
	return f
}

// orDefault 对应 query 解构默认值（仅 undefined 生效；空串保持原值）。
func orDefault(q map[string][]string, key, def string) string {
	if v, ok := q[key]; ok && len(v) > 0 {
		return v[0]
	}
	return def
}

// jsParseFloat 复刻 parseInt(str, 10) 宽松前缀解析，失败返回 NaN。
func jsParseFloat(s string) float64 {
	s = strings.TrimSpace(s)
	end, seenDigit := 0, false
loop:
	for i := 0; i < len(s); i++ {
		c := s[i]
		switch {
		case c >= '0' && c <= '9':
			seenDigit = true
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

// jsNumberOr 对应 Number(v) || def（NaN/0/空 → def）。
func jsNumberOr(v any, def int) int {
	switch t := v.(type) {
	case string:
		f, err := strconv.ParseFloat(strings.TrimSpace(t), 64)
		if err != nil || f == 0 {
			return def
		}
		return int(f)
	case json.Number:
		f, err := t.Float64()
		if err != nil || f == 0 {
			return def
		}
		return int(f)
	case float64:
		if t == 0 || math.IsNaN(t) {
			return def
		}
		return int(t)
	}
	return def
}

// jsSubstring 对应 String#substring(start, end)（按 UTF-16 code unit）。
func jsSubstring(s string, start, end int) string {
	u := utf16.Encode([]rune(s))
	n := len(u)
	if start < 0 {
		start = 0
	}
	if end > n {
		end = n
	}
	if start > end {
		start = end
	}
	return string(utf16.Decode(u[start:end]))
}

// truthy 对应 JS 真值判断（非空字符串皆真，含 "false"/"0"）。
func truthy(v any) bool {
	switch t := v.(type) {
	case nil:
		return false
	case bool:
		return t
	case string:
		return t != ""
	case float64:
		return t != 0 && !math.IsNaN(t)
	case int64:
		return t != 0
	case int:
		return t != 0
	}
	return true
}

// orEmpty 对应 content || ""。
func orEmpty(v any) any {
	if truthy(v) {
		return v
	}
	return ""
}

// jsonStringOrNull 对应 v ? JSON.stringify(v) : null。
func jsonStringOrNull(v any) any {
	if !truthy(v) {
		return nil
	}
	return mustJSON(v)
}

// jsonStringifyOrNull 对应 JSON.stringify(v)：undefined/null → null，其余序列化（0 → "0"）。
func jsonStringifyOrNull(v any) any {
	// 🔒 SYNC-A43（2026-10-13）：nil 应产出**字符串 "null"**，不是 SQL NULL。
	// Node moment/controller/index.js:155-156 是 JSON.stringify(visibleType)，
	// 而 JSON.stringify(null) === "null"（4 个字符的字符串）。
	// 旧实现返回 nil ⇒ 落库 SQL NULL ⇒ 读回时 Node 得 null、Go 得 {vt:0,vs:0,pw:0}。
	if v == nil {
		return "null"
	}
	return mustJSON(v)
}

// jsonStringOr 对应 v ? JSON.stringify(v) : def。
func jsonStringOr(v any, def string) any {
	if !truthy(v) {
		return def
	}
	return mustJSON(v)
}

// mustJSON JSON.stringify（marshal 失败时返回 nil，对应 Node 循环引用等异常外的默认行为）。
func mustJSON(v any) string {
	b, err := json.Marshal(v)
	if err != nil {
		return ""
	}
	return string(b)
}

// jsonString 输出 JSON 字符串字面量（含引号与转义）。
func jsonString(s string) string {
	b, _ := json.Marshal(s)
	return string(b)
}

// urlQueryEscape 对应 encodeURIComponent（对 token 的 base64url 串基本等价）。
func urlQueryEscape(s string) string {
	var sb strings.Builder
	for i := 0; i < len(s); i++ {
		c := s[i]
		if (c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') ||
			c == '-' || c == '_' || c == '.' || c == '!' || c == '~' || c == '*' || c == '\'' || c == '(' || c == ')' {
			sb.WriteByte(c)
		} else {
			sb.WriteString(fmt.Sprintf("%%%02X", c))
		}
	}
	return sb.String()
}

func toF(v any) float64 {
	switch t := v.(type) {
	case float64:
		return t
	case json.Number:
		f, _ := t.Float64()
		return f
	case int64:
		return float64(t)
	case int:
		return float64(t)
	case string:
		f, err := strconv.ParseFloat(strings.TrimSpace(t), 64)
		if err != nil {
			return math.NaN()
		}
		return f
	}
	return math.NaN()
}
