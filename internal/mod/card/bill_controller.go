package card

import (
	"fmt"
	"net/http"

	"live/api/internal/db"
	"live/api/internal/mod/cardbill"
	"live/api/internal/mod/creditcore"
	"live/api/internal/resp"
)

// ============================================================================
// 卡片账单控制器 —— from: controller/billController.js
// ============================================================================

// BillList 获取账单列表（无账单时按需触发 CreditCore 重算）。
// keep BUG-035：空列表时遍历所有信用卡逐卡重建（GET 读接口触发全量写库），维持原样。
// from: billController.js:14-53
func BillList(w http.ResponseWriter, r *http.Request) {
	uid := resp.UID(r)
	q := r.URL.Query()
	cardID := q.Get("cardId")
	billMonth := q.Get("billMonth")

	bills, err := cardbill.FindAll(db.DB(), uid, cardID, billMonth)
	if err != nil {
		resp.Say(w, "获取失败", 500)
		return
	}

	// 如果没有账单且指定了卡片，尝试自动重建
	// [CreditCore] 统一重算（替代旧 rebuildBillFromAccount）
	if len(bills) == 0 && cardID != "" {
		if err := creditcore.SyncCardBills(db.DB(), cardID, uid); err != nil {
			resp.Say(w, "获取失败", 500)
			return
		}
		bills, err = cardbill.FindAll(db.DB(), uid, cardID, billMonth)
		if err != nil {
			resp.Say(w, "获取失败", 500)
			return
		}
	}

	// 仍然没有，且没有指定卡片，尝试为所有信用卡重建（keep BUG-035）
	if len(bills) == 0 && cardID == "" {
		creditCards, err := CardFindAll(uid, cardFilters{cardType: "credit"})
		if err != nil {
			resp.Say(w, "获取失败", 500)
			return
		}
		for _, card := range creditCards {
			// [CreditCore] 统一重算
			if err := creditcore.SyncCardBills(db.DB(), toStr(card["id"]), uid); err != nil {
				resp.Say(w, "获取失败", 500)
				return
			}
		}
		bills, err = cardbill.FindAll(db.DB(), uid, cardID, billMonth)
		if err != nil {
			resp.Say(w, "获取失败", 500)
			return
		}
	}

	if len(bills) == 0 {
		resp.JSON(w, 200, map[string]any{"status": 200, "message": "暂无账单", "data": []any{}})
		return
	}
	resp.JSON(w, 200, map[string]any{"status": 200, "message": "获取成功", "data": bills})
}

// BillDetail 获取单个账单详情（实时计算逾期状态）。
// from: billController.js:58-75
func BillDetail(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	if id == "" {
		resp.Say(w, "账单id不能为空", 400)
		return
	}
	bill, err := cardbill.FindById(db.DB(), id, resp.UID(r))
	if err != nil {
		resp.Say(w, "获取失败", 500)
		return
	}
	if bill == nil {
		resp.Say(w, "账单不存在", 200)
		return
	}

	// 实时计算逾期状态（已还清/待还为0时不应显示逾期）
	if _, ok := bill["is_overdue_calc"]; ok {
		bill["is_overdue"] = bill["is_overdue_calc"]
		bill["overdue_days"] = bill["overdue_days_calc"]
	}
	resp.JSON(w, 200, map[string]any{"status": 200, "message": "获取成功", "data": bill})
}

// BillLatest 获取卡片最新账单。
// from: billController.js:80-97
func BillLatest(w http.ResponseWriter, r *http.Request) {
	cardID := r.PathValue("cardId")
	if cardID == "" {
		resp.Say(w, "卡片id不能为空", 400)
		return
	}
	bill, err := cardbill.FindLatestByCardId(db.DB(), cardID, resp.UID(r))
	if err != nil {
		resp.Say(w, "获取失败", 500)
		return
	}
	if bill == nil {
		resp.JSON(w, 200, map[string]any{"status": 200, "message": "暂无账单", "data": nil})
		return
	}
	resp.JSON(w, 200, map[string]any{"status": 200, "message": "获取成功", "data": bill})
}

// BillEdit 更新账单。
// from: billController.js:102-120
func BillEdit(w http.ResponseWriter, r *http.Request) {
	uid := resp.UID(r)
	id := r.PathValue("id")
	d := ruleData(r)
	// Node CardBill.update(id, userId, req.body.data)：data 缺失时 Object.keys(undefined) 抛 TypeError
	if d == nil {
		resp.Say(w, "Cannot convert undefined or null to object", 500)
		return
	}
	if _, err := cardbill.UpdateBill(db.DB(), id, uid, d); err != nil {
		resp.Say(w, err.Error(), 500) // Node res.say(error.message || "更新失败", 500)
		return
	}
	// Node CardBill.update 返回 findById 整行（无有效字段时同样返回原行）
	bill, err := cardbill.FindById(db.DB(), id, uid)
	if err != nil {
		resp.Say(w, "获取失败", 500)
		return
	}
	if bill == nil {
		resp.Say(w, "账单不存在", 404)
		return
	}

	// 记录操作日志
	_ = Log(toStr(bill["card_id"]), uid, "更新账单", clientIP(r))

	resp.JSON(w, 200, map[string]any{"status": 200, "message": "更新成功", "data": bill})
}

// BillRebuild 重建账单（从流水重新计算）。
// from: billController.js:125-148
func BillRebuild(w http.ResponseWriter, r *http.Request) {
	cardID := r.PathValue("cardId")
	if cardID == "" {
		resp.Say(w, "卡片id不能为空", 400)
		return
	}
	uid := resp.UID(r)
	// [CreditCore] 从账本统一重算所有账单
	if err := creditcore.SyncCardBills(db.DB(), cardID, uid); err != nil {
		resp.Say(w, "重建失败", 500)
		return
	}
	// 获取重建后的最新账单列表
	bills, err := cardbill.FindAll(db.DB(), uid, cardID, "")
	if err != nil {
		resp.Say(w, "重建失败", 500)
		return
	}

	// 记录操作日志
	_ = Log(cardID, uid, "重建账单", clientIP(r))

	// 注：Node 消息计数取 syncCardBills 返回快照数（共享池卡为全池口径）；
	// Go 端 SyncCardBills 无快照返回，此处用本卡账单数（单卡口径一致，池内卡为池范围差异）。
	resp.JSON(w, 200, map[string]any{
		"status":  200,
		"message": fmt.Sprintf("已重建 %d 个月账单", len(bills)),
		"data":    bills,
	})
}

// BillRemove 删除账单。
// from: billController.js:187-204
func BillRemove(w http.ResponseWriter, r *http.Request) {
	uid := resp.UID(r)
	id := r.PathValue("id")
	bill, err := cardbill.FindById(db.DB(), id, uid)
	if err != nil {
		resp.Say(w, "删除失败", 500)
		return
	}
	if bill == nil {
		resp.Say(w, "账单不存在", 404)
		return
	}
	affected, err := cardbill.DeleteBill(db.DB(), id, uid)
	if err != nil {
		resp.Say(w, "删除失败", 500)
		return
	}
	if affected == 0 {
		resp.Say(w, "账单不存在", 404)
		return
	}

	// 记录操作日志
	_ = Log(toStr(bill["card_id"]), uid, "删除账单", clientIP(r))

	resp.JSON(w, 200, map[string]any{"status": 200, "message": "删除成功"})
}

// ===================== 外币消费登记/对账（痛点4） —— from: billController.js:206-341 =====================

// BillForeignPending 待对账外币列表（专用登记页）。
// from: billController.js:209-217
func BillForeignPending(w http.ResponseWriter, r *http.Request) {
	list, err := creditcore.GetPendingRegisters(db.DB(), resp.UID(r))
	if err != nil {
		resp.Say(w, "获取失败", 500)
		return
	}
	resp.JSON(w, 200, map[string]any{"status": 200, "message": "获取成功", "data": list})
}

// BillForeignList 全部外币登记列表。
// from: billController.js:220-228
func BillForeignList(w http.ResponseWriter, r *http.Request) {
	list, err := creditcore.GetForeignRegisters(db.DB(), resp.UID(r))
	if err != nil {
		resp.Say(w, "获取失败", 500)
		return
	}
	resp.JSON(w, 200, map[string]any{"status": 200, "message": "获取成功", "data": list})
}

// BillForeignHistory 历史外币消费流水（扫描 account 账本，含未登记，按卡/时间范围筛选）。
// from: billController.js:231-240
func BillForeignHistory(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	list, err := creditcore.FindForeignExpenseHistory(db.DB(), resp.UID(r),
		q.Get("cardId"), q.Get("startDate"), q.Get("endDate"))
	if err != nil {
		resp.Say(w, "获取失败", 500)
		return
	}
	resp.JSON(w, 200, map[string]any{"status": 200, "message": "获取成功", "data": list})
}

// BillForeignRegister 补登记未登记的历史外币消费流水。
// 补登记与账单重算同一事务（H4：避免登记建成但账单未重算的半完成态）。
// from: billController.js:248-290
func BillForeignRegister(w http.ResponseWriter, r *http.Request) {
	uid := resp.UID(r)
	d := dataOrRaw(resp.Parse(r)) // Node `req.body.data || req.body`
	accountID := toStr(d["accountId"])
	if accountID == "" {
		resp.Say(w, "流水ID不能为空", 400)
		return
	}

	tx, err := db.GetPool().Begin()
	if err != nil {
		resp.Say(w, "登记失败", 500)
		return
	}
	committed := false
	defer func() {
		if !committed {
			_ = tx.Rollback()
		}
	}()

	row, err := qRow(tx,
		`SELECT a.id, a.card_id, a.amount, a.currency, a.exchange_rate, c.card_type
         FROM account a
         JOIN card_base c ON a.card_id = c.id AND c.user_id = a.user_id AND c.is_deleted = 0
         WHERE a.id = ? AND a.user_id = ? AND a.is_deleted = 0 AND a.direction = 0 AND a.reversed_id IS NULL`,
		accountID, uid)
	if err != nil {
		resp.Say(w, err.Error(), 500)
		return
	}
	if row == nil {
		resp.Say(w, "外币消费流水不存在", 500)
		_ = tx.Rollback()
		return
	}
	if toStr(row["card_type"]) != "credit" {
		resp.Say(w, "该流水不是信用卡消费", 500)
		_ = tx.Rollback()
		return
	}
	if toStr(row["currency"]) == "" || toStr(row["currency"]) == "CNY" {
		resp.Say(w, "该流水不是外币消费，无需登记", 500)
		_ = tx.Rollback()
		return
	}
	rate, _ := jsNum(row["exchange_rate"])
	if rate != rate || rate <= 0 { // NaN 或 <= 0（Node `!Number(x) || Number(x) <= 0`）
		resp.Say(w, "该流水缺少登记汇率，无法自动登记，请先在消费录入页补全汇率", 500)
		_ = tx.Rollback()
		return
	}
	regID, err := creditcore.EnsurePendingRegister(tx, uid, toStr(row["card_id"]), accountID,
		toStr(row["currency"]), toF(row["amount"]), rate)
	if err != nil {
		resp.Say(w, err.Error(), 500)
		_ = tx.Rollback()
		return
	}
	// 补登记后该笔从「回退 toCNY 入账」变为「pending 占额不入账」，需重算该卡（含共享池扩散）
	if err := creditcore.SyncCardBills(tx, toStr(row["card_id"]), uid); err != nil {
		resp.Say(w, err.Error(), 500)
		_ = tx.Rollback()
		return
	}
	if err := tx.Commit(); err != nil {
		resp.Say(w, "登记失败", 500)
		return
	}
	committed = true

	reg, err := creditcore.FindById(db.DB(), regID, uid)
	if err != nil {
		resp.Say(w, "登记失败", 500)
		return
	}
	resp.JSON(w, 200, map[string]any{"status": 200, "message": "已登记为待对账", "data": reg})
}

// BillForeignReconcile 外币对账：录入实际汇率/人民币（或修改）。
// P1-5 审计：对账金额/汇率必须为正，否则可把外币消费"归零"从账单消失。
// from: billController.js:293-317
func BillForeignReconcile(w http.ResponseWriter, r *http.Request) {
	uid := resp.UID(r)
	id := r.PathValue("id")
	d := dataOrRaw(resp.Parse(r))

	rate, rateOK := jsNum(d["actualRate"])
	if !rateOK || rate != rate || rate <= 0 {
		resp.Say(w, "实际汇率必须大于 0", 400)
		return
	}
	var rmb float64
	if v, ok := d["actualRmb"]; ok && v != nil && toStr(v) != "" {
		f, ok := jsNum(v)
		if !ok || f != f || f <= 0 {
			resp.Say(w, "实际人民币金额必须大于 0", 400)
			return
		}
		rmb = f
	}
	// ReconcileForeign 内部自建事务（登记对账 + 账单重算同一事务，H4）；
	// Go 契约定位为 error（Node 侧返回对账后的登记行，此处成功后按 id 复读）
	if err := creditcore.ReconcileForeign(db.DB(), id, uid, rate, rmb,
		toStr(d["settleDate"]), toStr(d["remark"])); err != nil {
		resp.Say(w, err.Error(), 500) // Node res.say(error.message || "对账失败", 500)
		return
	}
	reg, err := creditcore.FindById(db.DB(), id, uid)
	if err != nil {
		resp.Say(w, err.Error(), 500)
		return
	}
	resp.JSON(w, 200, map[string]any{"status": 200, "message": "对账成功", "data": reg})
}

// BillForeignRemove 删除外币登记（H4：删除与账单重算同一事务，避免 pending 释放后额度不同步）。
// from: billController.js:320-341
func BillForeignRemove(w http.ResponseWriter, r *http.Request) {
	uid := resp.UID(r)
	id := r.PathValue("id")

	tx, err := db.GetPool().Begin()
	if err != nil {
		resp.Say(w, "删除失败", 500)
		return
	}
	committed := false
	defer func() {
		if !committed {
			_ = tx.Rollback()
		}
	}()

	reg, err := creditcore.FindById(tx, id, uid)
	if err != nil {
		resp.Say(w, err.Error(), 500)
		_ = tx.Rollback()
		return
	}
	if reg == nil {
		resp.Say(w, "外币登记记录不存在", 500)
		_ = tx.Rollback()
		return
	}
	cardID := toStr(reg["card_id"])
	if err := creditcore.Delete(tx, id, uid); err != nil {
		resp.Say(w, err.Error(), 500)
		_ = tx.Rollback()
		return
	}
	// 删除登记后重算对应卡（含共享池扩散）
	if err := creditcore.SyncCardBills(tx, cardID, uid); err != nil {
		resp.Say(w, err.Error(), 500)
		_ = tx.Rollback()
		return
	}
	if err := tx.Commit(); err != nil {
		resp.Say(w, "删除失败", 500)
		return
	}
	committed = true
	resp.JSON(w, 200, map[string]any{"status": 200, "message": "删除成功"})
}
