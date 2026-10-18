package card

import (
	"net/http"
	"strings"

	// 🔧 2026-10-11 修复：原 import 少了 mod/ 层（live/api/internal/account 不存在），
	//   导致全仓 go build 失败。业务模块实际位于 internal/mod/<pkg>。
	"live/api/internal/mod/account"
	"live/api/internal/mw"
	"live/api/internal/resp"
)

// ============================================================================
// 卡片控制器 —— from: controller/index.js
// ============================================================================

// clientIP 对应 Node 的 req.ip。
//
// 🔒 SYNC-A39（2026-10-12）：改为复用 mw.ClientIP。
//
// 旧实现是本地复刻的一版，注释写"mw.clientIP 未导出"—— **该注释已过期**：
// mw.ClientIP 早已导出，且语义**不同**：
//
//	旧（错误）：X-Forwarded-For 取**最左段**
//	正确：      按 TRUST_PROXY_HOPS 取倒数第 hops 段（hops=0 ⇒ 完全不信任 XFF）
//
// 二者不只是取段位置不同 —— 最左段是**客户端可任意伪造**的值。
// 攻击者只要自带 `X-Forwarded-For: 1.1.1.1`，就能把 card_log.operate_ip
// 伪造成任意地址，审计日志失去真实性。这正是 P1-18 已修掉的漏洞，
// 本函数相当于把它重新引入了。
//
// Node 侧对应 app.js:53 的 trust proxy 语义（trust proxy = 1 → 取倒数第 2 段）。
func clientIP(r *http.Request) string { return mw.ClientIP(r) }

// GetList 获取卡片列表。
// from: controller/index.js:14-30
func GetList(w http.ResponseWriter, r *http.Request) {
	uid := resp.UID(r)
	q := r.URL.Query()
	f := cardFilters{}
	if v := q.Get("cardType"); v != "" {
		f.cardType = v
	}
	// fix BUG-031：Node `parseInt(isHide)` 对 'false' 得 NaN → `is_hide = NULL` 恒空列表；
	// Go 端按布尔判断（'false'/'0' → 0）。
	if _, ok := q["isHide"]; ok {
		f.isHideSet = true
		f.isHide = jsIsHideQuery(q.Get("isHide"))
	}

	cards, err := CardFindAll(uid, f)
	if err != nil {
		resp.Say(w, "获取失败", 500)
		return
	}
	if len(cards) == 0 {
		resp.Say(w, "暂无卡片", 204)
		return
	}
	resp.JSON(w, 200, map[string]any{"status": 200, "message": "获取成功", "data": cards})
}

// jsIsHideQuery 对应 parseInt(isHide) 并 fix BUG-031（布尔判断）。
// Node parseInt('false') = NaN → mysql2 发送 NULL → `is_hide = NULL` 恒空列表（BUG-031）。
// Go 端：'false'/'0' → 0；'true'/'1' → 1；其余按 parseInt 宽松前缀解析（NaN → 0）。
func jsIsHideQuery(s string) int {
	switch strings.ToLower(strings.TrimSpace(s)) {
	case "false", "0", "":
		return 0
	case "true", "1":
		return 1
	}
	f, ok := jsNum(s)
	if !ok || f != f { // NaN
		return 0
	}
	return int(f)
}

// GetById 获取单个卡片详情。
// from: controller/index.js:35-47
func GetById(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	if id == "" {
		resp.Say(w, "卡片id不能为空", 400)
		return
	}
	card, err := CardFindById(id, resp.UID(r))
	if err != nil {
		resp.Say(w, "获取失败", 500)
		return
	}
	// R4：findById 返回单卡对象（非数组），原 `card.length === 0` 判断永不生效
	if card == nil {
		resp.Say(w, "卡片不存在", 404)
		return
	}
	resp.JSON(w, 200, map[string]any{"status": 200, "message": "获取成功", "data": card})
}

// Create 创建卡片（创建时初始化余额快照 + 记录操作日志）。
// from: controller/index.js:52-78
func Create(w http.ResponseWriter, r *http.Request) {
	uid := resp.UID(r)
	card, err := CreateCard(uid, ruleData(r))
	if err != nil {
		// Node res.say(error.message || "创建失败", 500)
		msg := err.Error()
		if msg == "" {
			msg = "创建失败"
		}
		resp.Say(w, msg, 500)
		return
	}
	if card == nil || card["id"] == nil {
		resp.Say(w, "卡片创建失败", 500)
		return
	}

	// ===== 创建卡片时初始化余额快照 =====
	if _, err := account.InitCardBalance(toStr(card["id"]), uid); err != nil {
		resp.Say(w, err.Error(), 500)
		return
	}

	// 记录操作日志
	_ = Log(toStr(card["id"]), uid, "创建卡片", clientIP(r))

	resp.JSON(w, 200, map[string]any{"status": 200, "message": "创建成功", "data": card})
}

// Update 更新卡片。
// from: controller/index.js:83-97
func Update(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	card, err := UpdateCard(id, resp.UID(r), ruleData(r))
	if err != nil {
		// Node res.say(error, 500)：Error 对象 → err.message（生产 5xx 脱敏为"服务器内部错误"）
		resp.SayErr(w, err, 500)
		return
	}
	if card == nil {
		resp.Say(w, "卡片不存在", 404)
		return
	}

	// 记录操作日志
	_ = Log(id, resp.UID(r), "更新卡片", clientIP(r))

	resp.JSON(w, 200, map[string]any{"status": 200, "message": "更新成功", "data": card})
}

// UpdateSortBatch 批量更新排序：前端整列 1-N 重排后一次提交。
// body: { items: [{ id, sort }] }
// from: controller/index.js:103-115
func UpdateSortBatch(w http.ResponseWriter, r *http.Request) {
	uid := resp.UID(r)
	b := resp.Parse(r)

	// Node `req.body.items || req.body.data?.items || req.body`（该路由无 Joi validator，取原始 body）
	var items any
	if v, ok := b.Raw["items"]; ok && truthy(v) {
		items = v
	} else if v, ok := b.Data["items"]; ok && truthy(v) {
		items = v
	} else {
		items = b.Raw
	}
	arr, ok := items.([]any)
	if !ok || len(arr) == 0 {
		resp.Say(w, "排序数据为空", 400)
		return
	}
	if err := CardUpdateSortBatch(uid, arr); err != nil {
		resp.Say(w, "排序保存失败", 500)
		return
	}
	resp.JSON(w, 200, map[string]any{"status": 200, "message": "排序已保存"})
}

// Delete 删除卡片。
// from: controller/index.js:120-134
func Delete(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	result, err := DeleteCard(id, resp.UID(r))
	if err != nil {
		resp.Say(w, "删除失败", 500)
		return
	}
	if !result {
		resp.Say(w, "卡片不存在", 404)
		return
	}

	// 记录操作日志
	_ = Log(id, resp.UID(r), "删除卡片", clientIP(r))

	resp.JSON(w, 200, map[string]any{"status": 200, "message": "删除成功"})
}

// ===================== 共享额度池（痛点2） —— from: controller/index.js:136-202 =====================

// CreatePool 创建共享池。
// from: controller/index.js:139-152
func CreatePool(w http.ResponseWriter, r *http.Request) {
	uid := resp.UID(r)
	d := dataOrRaw(resp.Parse(r)) // Node `req.body.data || req.body`
	// Node destructure 默认值：bankId=null/bankName=null/totalCreditLimit=0/totalTempLimit=0/
	// creditReportMerged=0/currency="CNY"/remark=null（仅 undefined 时生效）
	var currency any = "CNY"
	if v, ok := d["currency"]; ok && v != nil {
		currency = toStr(v)
	}
	pool, err := PoolCreate(uid,
		strOrNil(d["bankId"]), strOrNil(d["bankName"]),
		jnum(d, "totalCreditLimit", 0), jnum(d, "totalTempLimit", 0),
		jbool(d, "creditReportMerged"),
		currency, strOrNil(d["remark"]),
	)
	if err != nil {
		resp.Say(w, "创建失败", 500)
		return
	}
	resp.JSON(w, 200, map[string]any{"status": 200, "message": "创建成功", "data": pool})
}

// UpdatePool 更新共享池。
// from: controller/index.js:155-167
func UpdatePool(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	d := dataOrRaw(resp.Parse(r))
	pool, err := PoolUpdate(id, resp.UID(r), d)
	if err != nil {
		resp.Say(w, "更新失败", 500)
		return
	}
	if pool == nil {
		resp.Say(w, "共享池不存在", 404)
		return
	}
	resp.JSON(w, 200, map[string]any{"status": 200, "message": "更新成功", "data": pool})
}

// ListPools 列出我的共享池。
// from: controller/index.js:170-178
func ListPools(w http.ResponseWriter, r *http.Request) {
	pools, err := PoolFindByUser(resp.UID(r))
	if err != nil {
		resp.Say(w, "获取失败", 500)
		return
	}
	resp.JSON(w, 200, map[string]any{"status": 200, "message": "获取成功", "data": pools})
}

// DeletePool 删除共享池。
// fix BUG-053：Node 不校验 affectedRows 恒 200（删不存在的池也返回成功），Go 端补校验 → 404。
// from: controller/index.js:181-189
func DeletePool(w http.ResponseWriter, r *http.Request) {
	result, err := PoolDelete(r.PathValue("id"), resp.UID(r))
	if err != nil {
		resp.Say(w, "删除失败", 500)
		return
	}
	if !result {
		resp.Say(w, "共享池不存在", 404)
		return
	}
	resp.JSON(w, 200, map[string]any{"status": 200, "message": "删除成功"})
}

// AssignCardPool 把卡片归入/移出共享池。
// from: controller/index.js:192-202
func AssignCardPool(w http.ResponseWriter, r *http.Request) {
	uid := resp.UID(r)
	d := dataOrRaw(resp.Parse(r))
	cardID := jstr(d, "cardId", "")
	poolID := jstr(d, "poolId", "")
	// assignCard 内部已事务化更新 share_pool_id 并全池重算（旧池/新池/本卡，H1 审计）
	if err := PoolAssignCard(cardID, uid, poolID); err != nil {
		resp.Say(w, "操作失败", 500)
		return
	}
	resp.JSON(w, 200, map[string]any{"status": 200, "message": "操作成功"})
}

// dataOrRaw 对应 Node `req.body.data || req.body`（含 data={} 空对象也优先生效）。
func dataOrRaw(b resp.Body) map[string]any {
	if v, ok := b.Raw["data"]; ok && v != nil {
		if m, ok := v.(map[string]any); ok {
			return m
		}
	}
	return b.Raw
}
