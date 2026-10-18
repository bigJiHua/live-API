package card

import (
	"fmt"
	"net/http"

	"live/api/internal/resp"
)

// ============================================================================
// 卡片还款控制器 —— from: controller/repayController.js
// ============================================================================

// RepayList 获取还款记录列表。
// from: repayController.js:12-29
func RepayList(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	filters := map[string]any{}
	if v := q.Get("cardId"); v != "" {
		filters["cardId"] = v
	}
	if v := q.Get("billId"); v != "" {
		filters["billId"] = v
	}
	if v := q.Get("billMonth"); v != "" {
		filters["billMonth"] = v
	}

	records, err := RepayFindAll(resp.UID(r), filters)
	if err != nil {
		resp.Say(w, "获取失败", 500)
		return
	}
	if len(records) == 0 {
		resp.Say(w, "暂无还款记录", 200)
		return
	}
	resp.JSON(w, 200, map[string]any{"status": 200, "message": "获取成功", "data": records})
}

// RepayDetail 获取单个还款记录详情。
// from: repayController.js:34-45
func RepayDetail(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	if id == "" {
		resp.Say(w, "还款记录id不能为空", 400)
		return
	}
	record, err := RepayFindById(id, resp.UID(r))
	if err != nil {
		resp.Say(w, "获取失败", 500)
		return
	}
	if record == nil {
		resp.Say(w, "还款记录不存在", 404)
		return
	}
	resp.JSON(w, 200, map[string]any{"status": 200, "message": "获取成功", "data": record})
}

// RepayCreate 创建还款记录（支持多种还款方式）。
// repayMethod: balance(余额)/bank_card(银行卡)/cash(现金)；bank_card 时需要传入 repayMethodCardId。
// from: repayController.js:52-93
func RepayCreate(w http.ResponseWriter, r *http.Request) {
	uid := resp.UID(r)
	d := ruleData(r)
	// Node `const { cardId, billId, repayAmount, ... } = req.body.data`（data 缺失即 TypeError）
	if d == nil {
		resp.Say(w, "Cannot destructure property 'cardId' of 'req.body.data' as it is undefined.", 500)
		return
	}

	// 使用 executeRepay 方法（失败会抛出错误）
	repayAmount, _ := jsNum(d["repayAmount"])
	result, err := ExecuteRepay(RepayParams{
		UserID:            uid,
		CardID:            toStr(d["cardId"]),
		BillID:            toStr(d["billId"]),
		RepayAmount:       repayAmount,
		RepayMethod:       toStr(d["repayMethod"]),
		RepayMethodCardID: toStr(d["repayMethodCardId"]),
		RepayTime:         toStr(d["repayTime"]),
		Remark:            toStr(d["remark"]),
	})
	if err != nil {
		resp.Say(w, err.Error(), 500) // Node res.say(error.message || "创建失败", 500)
		return
	}

	// 检查返回值确保还款记录确实创建成功
	if result.RepayID == "" {
		resp.Say(w, "还款记录创建失败", 500)
		return
	}

	// 记录操作日志（Node: `还款 ${repayAmount}元`，repayAmount 为清洗后的数值）
	_ = Log(toStr(d["cardId"]), uid, "还款 "+jsNumString(repayAmount)+"元", clientIP(r))

	resp.JSON(w, 200, map[string]any{
		"status": 200, "message": "还款成功",
		"data": map[string]any{
			"repayId":           result.RepayID,
			"repayAmount":       result.RepayAmount,
			"actualRepayToBill": result.ActualRepayToBill,
			"newUsedLimit":      result.NewUsedLimit,
			"newAvailLimit":     result.NewAvailLimit,
		},
	})
}

// RepayMerge 信报合一合并还款：一次性结清共享池内全部卡的欠款。
// 前提：共享池已标记 credit_report_merged=1。
// from: repayController.js:99-139
func RepayMerge(w http.ResponseWriter, r *http.Request) {
	uid := resp.UID(r)
	d := dataOrRaw(resp.Parse(r)) // Node `req.body.data || req.body`
	poolID := toStr(d["poolId"])
	repayMethod := toStr(d["repayMethod"])

	if poolID == "" {
		resp.Say(w, "共享池ID不能为空", 400)
		return
	}
	if repayMethod == "" {
		resp.Say(w, "请选择还款方式", 400)
		return
	}

	result, err := ExecuteMergeRepay(uid, poolID, repayMethod,
		toStr(d["repayMethodCardId"]), toStr(d["repayTime"]), toStr(d["remark"]))
	if err != nil {
		resp.Say(w, err.Error(), 500) // Node res.say(error.message || "合并还款失败", 500)
		return
	}

	// 记录操作日志：card_log.card_id NOT NULL，用池内首张卡 id；
	// 日志失败不得让已成功的还款返回 500（否则前端误判失败可能重复提交）
	func() {
		defer func() { _ = recover() }()
		logCardID := poolID
		if len(result.CardIDs) > 0 {
			logCardID = result.CardIDs[0]
		}
		_ = Log(logCardID, uid, fmt.Sprintf("信报合一合并还款 %s元", jsNumString(result.TotalAmount)), clientIP(r))
	}()

	resp.JSON(w, 200, map[string]any{
		"status":  200,
		"message": fmt.Sprintf("合并还款成功，共还清 %d 笔欠款", result.Count),
		"data": map[string]any{
			"totalAmount": result.TotalAmount,
			"count":       result.Count,
			"repayIds":    result.RepayIDs,
			"cardIds":     result.CardIDs,
		},
	})
}

// RepayEdit 更新还款记录。
// from: repayController.js:144-158
func RepayEdit(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	d := ruleData(r)
	// Node destructure req.body.data（data 缺失即 TypeError）
	if d == nil {
		resp.Say(w, "Cannot destructure property 'repayAmount' of 'req.body.data' as it is undefined.", 500)
		return
	}
	record, err := RepayUpdate(id, resp.UID(r), d)
	if err != nil {
		resp.Say(w, err.Error(), 500) // Node res.say(error.message || "更新失败", 500)
		return
	}
	if record == nil {
		resp.Say(w, "还款记录不存在", 404)
		return
	}

	// 记录操作日志
	_ = Log(toStr(record["card_id"]), resp.UID(r), "更新还款记录", clientIP(r))

	resp.JSON(w, 200, map[string]any{"status": 200, "message": "更新成功", "data": record})
}

// RepayRemove 删除还款记录。
// from: repayController.js:163-180
func RepayRemove(w http.ResponseWriter, r *http.Request) {
	uid := resp.UID(r)
	id := r.PathValue("id")
	record, err := RepayFindById(id, uid)
	if err != nil {
		resp.Say(w, "删除失败", 500)
		return
	}
	if record == nil {
		resp.Say(w, "还款记录不存在", 404)
		return
	}
	result, err := RepayDelete(id, uid)
	if err != nil {
		// 🔒 SYNC-A39：Node repayController.js:176-179 是
		//   `res.say(error.message || "删除失败", 500)` —— 透传真实错误。
		// 旧实现统一回固定文案「删除失败」，排障时拿不到原因。
		// 用 SayErr 而非 Say：它对 5xx 做生产脱敏（对齐 app.js 的 res.say 语义），
		// dev 下仍显示 err.Error()，与 Node 完全同构。
		resp.SayErr(w, err, 500)
		return
	}
	if !result {
		resp.Say(w, "还款记录不存在", 404)
		return
	}

	// 记录操作日志
	_ = Log(toStr(record["card_id"]), uid, "删除还款记录", clientIP(r))

	resp.JSON(w, 200, map[string]any{"status": 200, "message": "删除成功"})
}
