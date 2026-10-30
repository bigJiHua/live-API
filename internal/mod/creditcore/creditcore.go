// Package creditcore 复刻 src/modules/card/core/CreditCore.js（信用卡核心计算层，唯一真相源）
// 与 src/modules/card/model/foreignRegister.js。SQL 逐字一致（? 占位）。
//
// 职责：独占信用卡「额度 / 已用 / 可用 / 已还 / 待还 / 溢缴款 / 积分 / 逾期」的全部派生计算。
// 设计红线（用户明确，禁止改动）：
//  1. 账单日/还款日推导复用 cardbill 的周期函数（GetBillMonthByDate / CalculateBillPeriod / CalculateRepayDate）。
//  2. 汇率语义不改动：外币→人民币一律走 cur.ToCNY（每 100 外币等值人民币，amount*rate/100）。
//
// keep 标注同 build_logs/api.logs：BUG-033（JS 兜底 15/25 vs SQL repay_day=0 双口径）、
// BUG-036（池内 N 张卡 N² 复杂度）维持原样。
package creditcore

import (
	"database/sql"
	"errors"
	"math"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/go-sql-driver/mysql"

	"live/api/internal/cur"
	"live/api/internal/db"
	"live/api/internal/idgen"
	"live/api/internal/mod/cardbill"
	"live/api/internal/tim"
)

// DAY_MS 对应 CreditCore.js DAY_MS。
const dayMS = 1000 * 60 * 60 * 24

func init() {
	// 对应 Node bill.js create/delete 内 require('../core/CreditCore').syncCardBills（避免循环依赖）。
	// 注意：Node 侧 syncCardBills 失败会向上抛（C8），本 hook 签名无 error 返回，重算失败不传播。
	cardbill.SyncCardBillsHook = func(ex db.Commiter, cardID, userID string) {
		_ = syncCardBills(ex, cardID, userID)
	}
}

// ===== 行 → map 工具（与 cardbill 包各自的私有副本，避免共享导出面） =====

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

// normVal DB 值 → JSON 友好值：[]byte→string；time.Time→Node JSON.stringify(Date) 的 UTC ISO 串；其余原样。
func normVal(v any) any {
	switch t := v.(type) {
	case []byte:
		return string(t)
	case time.Time:
		return t.UTC().Format("2006-01-02T15:04:05.000Z")
	}
	return v
}

// ===== 通用值转换（对应 JS 松散语义） =====

func toStr(v any) string {
	switch t := v.(type) {
	case nil:
		return ""
	case string:
		return t
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

// toF 对应 parseFloat(v) || 0。
func toF(v any) float64 {
	switch t := v.(type) {
	case nil:
		return 0
	case float64:
		return t
	case int64:
		return float64(t)
	case int:
		return float64(t)
	case string:
		f, err := strconv.ParseFloat(strings.TrimSpace(t), 64)
		if err != nil {
			return 0
		}
		return f
	}
	return 0
}

func toI(v any) int { return int(toF(v)) }

// toIntOrNil：NULL/缺失 → nil（保持 Node 原样透传的 NULL），其余取整。
// 用于 card_bill.bill_day / repay_day —— 这两列在存量脏数据里可能是 NULL，
// Node 直接写 NULL，Go 端不应折成 0（SYNC-A39）。
func toIntOrNil(v any) any {
	switch t := v.(type) {
	case nil:
		return nil
	case []byte:
		if len(t) == 0 {
			return nil
		}
		return atoiOrNil(string(t))
	case string:
		if t == "" {
			return nil
		}
		return atoiOrNil(t)
	case float64:
		return int(t)
	case int:
		return t
	case int64:
		return t
	case bool:
		return nil
	}
	return int(toF(v))
}

func atoiOrNil(s string) any {
	n, err := strconv.Atoi(strings.TrimSpace(s))
	if err != nil {
		return nil
	}
	return n
}

// parseLocalDate 对应 new Date(`${ymd}T00:00:00`)：本地零点。
func parseLocalDate(ymd string) time.Time {
	t, err := time.ParseInLocation("2006-01-02", ymd, tim.Loc())
	if err != nil {
		return time.Time{}
	}
	return t
}

// ===== 卡片 / 共享池查询（对应 getCard().findById / CreditPool.findById） =====
// 依赖方向 common ← creditcore ← account ← card：creditcore 不得 import card，
// 故 card_base / card_credit_pool 查询在包内复刻（SQL 逐字来自 card 模型）。

// cardFindById 对应 card/model/index.js:158 Card.findById（SELECT * + is_deleted=0）。
func cardFindById(ex db.Commiter, id, userID string) (map[string]any, error) {
	return qRow(ex,
		"SELECT * FROM card_base WHERE id = ? AND user_id = ? AND is_deleted = 0",
		id, userID)
}

// cardFindAllCredit 对应 card/model/index.js:113-124 Card.findAll({cardType:'credit'})。
// 差异说明：Node findAll 前置 initVirtualCards 副作用（虚拟现金/余额卡建档），
// Go 端该职责属 card 包；虚拟卡 card_type 非 'credit'，不影响聚合结果。
func cardFindAllCredit(ex db.Commiter, userID string) ([]map[string]any, error) {
	return qRows(ex, `
        SELECT card_base.id, card_base.user_id, card_base.bank_id, card_base.card_type, card_base.card_bin, card_base.card_length, card_base.last4_no, card_base.alias,
               card_base.open_date, card_base.expire_date, card_base.card_org, card_base.tag, card_base.bill_day, card_base.repay_day,
               card_base.credit_limit, card_base.temp_limit, card_base.points_rate, card_base.share_pool_id,
               card_base.card_img, card_base.color, b.name AS bank_name
        FROM card_base
        LEFT JOIN bus_category b ON b.id = card_base.bank_id AND b.type = 'bank' AND b.is_deleted = 0
        WHERE card_base.user_id = ? AND card_base.is_deleted = 0
          AND card_base.card_type = ?
        ORDER BY card_base.is_default DESC, card_base.sort ASC, card_base.create_time DESC`,
		userID, "credit")
}

// poolFindById 对应 card/model/pool.js:127-133 CreditPool.findById。
func poolFindById(ex db.Commiter, id, userID string) (map[string]any, error) {
	return qRow(ex,
		"SELECT * FROM card_credit_pool WHERE id = ? AND user_id = ? AND is_deleted = 0",
		id, userID)
}

// ===== 对外导出契约 =====

// SyncCardBills 对应 CreditCore.syncCardBills：同步一张卡的全部账单（账本全量重算后 upsert）。
// 共享池卡：整池原子重算；#syncOne 本身不扩散，避免递归。
func SyncCardBills(ex db.Commiter, cardID, userID string) error {
	return syncCardBills(ex, cardID, userID)
}

func syncCardBills(ex db.Commiter, cardID, userID string) error {
	card, err := cardFindById(ex, cardID, userID)
	if err != nil {
		return err
	}
	if card == nil || toStr(card["card_type"]) != "credit" {
		return nil // Node 返回 null
	}
	// 共享池卡：整池原子重算（H1 审计）。池内任何一张卡变动，池内所有卡快照同步刷新。
	// keep BUG-036：池内每张卡各跑一次池级聚合 SQL（N² 复杂度），维持原样。
	if poolID := toStr(card["share_pool_id"]); poolID != "" {
		poolCards, err := qRows(ex,
			"SELECT id FROM card_base WHERE share_pool_id = ? AND user_id = ? AND is_deleted = 0",
			poolID, userID)
		if err != nil {
			return err
		}
		for _, c := range poolCards {
			if err := syncOne(ex, toStr(c["id"]), userID); err != nil {
				return err
			}
		}
		return nil
	}
	return syncOne(ex, cardID, userID)
}

// SyncByDate 对应 CreditCore.syncByDate（语义上对应旧 syncFromExpense）：内部即全量重算，幂等。
// transDate 参数不使用（与 Node 一致，仅为保契约）。
func SyncByDate(ex db.Commiter, cardID, userID, transDate string) error {
	return syncCardBills(ex, cardID, userID)
}

// SyncByBill 对应 CreditCore.syncByBill（语义上对应旧 syncFromRepay / rebuild）。
// billID 参数不使用（与 Node 一致，仅为保契约）。
func SyncByBill(ex db.Commiter, cardID, userID, billID string) error {
	return syncCardBills(ex, cardID, userID)
}

// monthSnap 对应 #computeMonths 的单月快照结构（含 aggregate 用的 usedLimitOfNet 与 core 子对象）。
type monthSnap struct {
	billMonth      string
	creditLimit    float64
	tempLimit      float64
	usedLimit      float64
	availLimit     float64
	billAmount     float64
	repaid         float64
	needRepay      float64
	overflow       float64
	minRepay       float64
	usedLimitOfNet float64
	points         int
	repayStatus    string
	isOverdue      bool
	overdueDays    int
	billStartDate  string
	billEndDate    string
	core           map[string]any
}

// syncOne 对应 CreditCore.#syncOne：单卡重算（不扩散到池），供 syncCardBills 池内循环复用。
func syncOne(ex db.Commiter, cardID, userID string) error {
	card, err := cardFindById(ex, cardID, userID)
	if err != nil {
		return err
	}
	if card == nil || toStr(card["card_type"]) != "credit" {
		return nil
	}

	months, err := computeMonths(ex, card, userID)
	if err != nil {
		return err
	}
	now := tim.NowMS()
	// R2：快照冗余列 bill_day/repay_day/points_rate 需与 card_base 保持一致（改卡后刷新），
	// points_rate 列是 decimal(10,0) 整数，写入前取整避免严格模式截断报错
	pointsRate := toF(card["points_rate"])
	if pointsRate == 0 {
		pointsRate = 1 // Math.round(parseFloat(card.points_rate) || 1)
	}
	pointsRateWrite := int(math.Round(pointsRate))
	// 🔒 SYNC-A39：Node 原样透传 card.bill_day / card.repay_day（NULL → NULL）；
	// 旧实现用 toI() 把 NULL 折成 0，落库口径与 Node 不同
	// （账单列表展示该字段时一端 null、一端 0）。改为 nil 时写 NULL。
	billDay := toIntOrNil(card["bill_day"])
	repayDay := toIntOrNil(card["repay_day"])

	for _, m := range months {
		// 含软删行一起查：软删账单仍占用 uk_user_card_month，若不复活，
		// 同月重建必然撞 1062 → 该月账单永久缺失。
		existing, err := cardbill.FindByCardAndMonthIncludingDeleted(ex, cardID, m.billMonth)
		if err != nil {
			return err
		}
		if existing != nil {
			_, err = ex.Exec(
				`UPDATE card_bill SET
             is_deleted = 0, bill_day = ?, repay_day = ?, points_rate = ?,
             credit_limit = ?, temp_limit = ?, used_limit = ?, avail_limit = ?, bill_amount = ?,
             repaid = ?, need_repay = ?, repay_status = ?, is_overdue = ?, overdue_days = ?,
             points = ?, min_repay = ?, bill_start_date = ?, bill_end_date = ?, update_time = ?
           WHERE id = ?`,
				billDay, repayDay, pointsRateWrite,
				m.creditLimit, m.tempLimit, m.usedLimit, m.availLimit, m.billAmount,
				m.repaid, m.needRepay, m.repayStatus, boolToInt(m.isOverdue), m.overdueDays,
				m.points, m.minRepay, m.billStartDate, m.billEndDate, now, existing["id"])
			if err != nil {
				return err
			}
		} else {
			id := idgen.BillID()
			_, err = ex.Exec(
				`INSERT INTO card_bill
             (id, user_id, card_id, bill_month, bill_day, repay_day, credit_limit, temp_limit,
              used_limit, avail_limit, bill_amount, repaid, need_repay, repay_status,
              is_overdue, overdue_days, points, points_rate, min_repay, bill_start_date, bill_end_date,
              remind_switch, remind_days, create_time, update_time, is_deleted)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 3, ?, ?, 0)`,
				id, userID, cardID, m.billMonth, billDay, repayDay,
				m.creditLimit, m.tempLimit, m.usedLimit, m.availLimit, m.billAmount,
				m.repaid, m.needRepay, m.repayStatus, boolToInt(m.isOverdue), m.overdueDays,
				m.points, pointsRateWrite, m.minRepay, m.billStartDate, m.billEndDate, now, now)
			if err != nil {
				// 🔒 SYNC-A45（2026-10-13）：补 ER_DUP_ENTRY（1062）兜底。
				//
				// FindByCardAndMonth 无锁读 ⇒ 两个并发重算都判定不存在 ⇒ 都走 INSERT，
				// 撞 uk_user_card_month(user_id, card_id, bill_month)。
				// 而本函数的调用方大量在事务内（credit.go:255/468/670/809、
				// repay.go:336/727/806、bill_controller.go:362/454），
				// 未捕获时唯一键冲突会把外层业务事务整体回滚——
				// 表现为「还款失败/记账失败」，而真实原因是并发重算撞键，信息完全误导。
				//
				// 同项目的 cardbill.createBill（cardbill.go:684）早已捕获 1062，
				// 此处属遗漏而非设计决策。命中 1062 说明另一方已插好 ⇒ 转为 UPDATE（幂等）。
				var myErr *mysql.MySQLError
				if errors.As(err, &myErr) && myErr.Number == 1062 {
					if _, uerr := ex.Exec(
						`UPDATE card_bill SET
               is_deleted = 0, bill_day = ?, repay_day = ?, points_rate = ?,
               credit_limit = ?, temp_limit = ?, used_limit = ?, avail_limit = ?, bill_amount = ?,
               repaid = ?, need_repay = ?, repay_status = ?, is_overdue = ?, overdue_days = ?,
               points = ?, min_repay = ?, bill_start_date = ?, bill_end_date = ?, update_time = ?
             WHERE user_id = ? AND card_id = ? AND bill_month = ?`,
						billDay, repayDay, pointsRateWrite,
						m.creditLimit, m.tempLimit, m.usedLimit, m.availLimit, m.billAmount,
						m.repaid, m.needRepay, m.repayStatus, boolToInt(m.isOverdue), m.overdueDays,
						m.points, m.minRepay, m.billStartDate, m.billEndDate, now,
						userID, cardID, m.billMonth); uerr != nil {
						return uerr
					}
					continue
				}
				return err
			}
		}
	}
	return nil
}

func boolToInt(b bool) int {
	if b {
		return 1
	}
	return 0
}

// Aggregate 对应 CreditCore.aggregate：汇总用户全部信用卡的额度/负债（只读计算，不写库）。
// 分组：归入同一共享池的卡合并为一组；无池的卡各自一组（避免共享额度重复累加）。
func Aggregate(ex db.Commiter, userID string) (map[string]any, error) {
	cards, err := cardFindAllCredit(ex, userID)
	if err != nil {
		return nil, err
	}

	// Map 的插入序对应 Node for...of groups 的顺序
	type group struct {
		poolID string
		cards  []map[string]any
	}
	groups := map[string]*group{}
	var order []string
	for _, card := range cards {
		key := "c_" + toStr(card["id"])
		if pid := toStr(card["share_pool_id"]); pid != "" {
			key = "p_" + pid
		}
		g, ok := groups[key]
		if !ok {
			g = &group{poolID: toStr(card["share_pool_id"])}
			groups[key] = g
			order = append(order, key)
		}
		g.cards = append(g.cards, card)
	}

	var totalCreditLimit, totalTempLimit, totalDebt, totalAvail, totalOverflow float64
	out := []map[string]any{}

	for _, key := range order {
		g := groups[key]
		if g.poolID != "" {
			// —— 共享池：以池额度为准，负债 = 池内全部卡 netOwed 之和 ——
			pool, err := poolFindById(ex, g.poolID, userID)
			if err != nil {
				return nil, err
			}
			// 池被删除/找不到时，回退到组内卡片自身额度之和（P6 审计：不可按0导致负可用额度）
			fallbackCredit, fallbackTemp := 0.0, 0.0
			for _, c := range g.cards {
				fallbackCredit += toF(c["credit_limit"])
				fallbackTemp += toF(c["temp_limit"])
			}
			poolCredit, poolTemp := fallbackCredit, fallbackTemp
			if pool != nil {
				poolCredit = toF(pool["total_credit_limit"])
				poolTemp = toF(pool["total_temp_limit"])
			}
			poolNet, err := poolNetOwed(ex, g.poolID, userID)
			if err != nil {
				return nil, err
			}
			poolPending, err := poolPendingReserved(ex, g.poolID, userID)
			if err != nil {
				return nil, err
			}
			debt := math.Max(0, poolNet)
			avail := poolCredit + poolTemp - poolNet - poolPending
			overflow, err := poolOverflow(ex, g.poolID, userID)
			if err != nil {
				return nil, err
			}
			var bankName any // pool ? pool.bank_name : null
			if pool != nil {
				bankName = pool["bank_name"]
			}
			cardsOut := []map[string]any{}
			for _, c := range g.cards {
				cardsOut = append(cardsOut, map[string]any{"cardId": c["id"], "alias": c["alias"]})
			}
			totalCreditLimit += poolCredit
			totalTempLimit += poolTemp
			totalDebt += debt
			totalAvail += avail
			totalOverflow += overflow
			out = append(out, map[string]any{
				"poolId":      g.poolID,
				"bankName":    bankName,
				"shared":      true,
				"creditLimit": poolCredit,
				"tempLimit":   poolTemp,
				"debt":        debt,
				"avail":       avail,
				"overflow":    overflow,
				"cards":       cardsOut,
			})
		} else {
			// —— 独立卡 ——
			card := g.cards[0]
			months, err := computeMonths(ex, card, userID)
			if err != nil {
				return nil, err
			}
			cardCredit := toF(card["credit_limit"])
			cardTemp := toF(card["temp_limit"])
			totalNet, overflow := 0.0, 0.0
			for _, m := range months {
				// 各账期增量净负债之和 = 累计消费 − 累计还款（可为负）
				totalNet += m.usedLimitOfNet
				// H7：累计溢缴余额取最后一月，跨月不重复累计
				overflow = m.overflow
			}
			// R1 审计：真实待还 = max(0, 累计净负债)，不能用 Σ needRepay
			debt := math.Max(0, totalNet)
			// 可用额度 = 总额度 − 全部账期净负债之和 − pending 外币占用（与快照 availLimit 口径一致）
			pendingReserved, err := pendingReservedCard(ex, toStr(card["id"]), userID)
			if err != nil {
				return nil, err
			}
			avail := cardCredit + cardTemp - totalNet - pendingReserved
			totalCreditLimit += cardCredit
			totalTempLimit += cardTemp
			totalDebt += debt
			totalAvail += avail
			totalOverflow += overflow
			out = append(out, map[string]any{
				"cardId":      card["id"],
				"alias":       card["alias"],
				"shared":      false,
				"creditLimit": cardCredit,
				"tempLimit":   cardTemp,
				"debt":        debt,
				"avail":       avail,
				"overflow":    overflow,
			})
		}
	}

	return map[string]any{
		"totalCreditLimit": totalCreditLimit,
		"totalTempLimit":   totalTempLimit,
		"totalDebt":        totalDebt,
		"totalAvail":       totalAvail,
		"totalOverflow":    totalOverflow,
		"cards":            out,
	}, nil
}

// ReconcileForeign 对应 CreditCore.reconcileForeign：外币消费登记/对账。
// H4 审计：登记对账与账单重算必须同一事务，避免半完成态（Node 自建事务，此处对 *sql.DB 入参同样自建）。
func ReconcileForeign(ex db.Commiter, id, userID string, actualRate, actualRmb float64, settleDate, remark string) error {
	tx, own, err := beginTx(ex)
	if err != nil {
		return err
	}
	reg, err := Reconcile(tx, id, userID, actualRate, actualRmb, settleDate, remark)
	if err != nil {
		rollbackTx(tx, own)
		return err
	}
	if err := syncCardBills(tx, toStr(reg["card_id"]), userID); err != nil {
		rollbackTx(tx, own)
		return err
	}
	if own {
		return tx.Commit()
	}
	return nil
}

// beginTx：ex 已是事务则沿用；否则从连接池开启（对应 Node db.getConnection + beginTransaction）。
//
// ⚠ SYNC-A39 契约约束（已核实当前调用链，无行为变更，仅固化约束）：
//
//	Node CreditCore.js:260 的 reconcileForeign **无条件自建事务**，
//	与调用方事务完全独立。若这里"沿用调用方事务"，则外层 rollback 时
//	Node 的对账已提交、Go 的会被一起回滚 ⇒ 两端结果相反。
//
//	当前唯一调用方（card/bill_controller.go:405）传的就是 db.DB()（非事务），
//	故 beginTx 自建事务、own=true、正常 commit —— 已与 Node 一致。
//	**后续若新增调用方传入 *sql.Tx，行为会偏离 Node**，届时需在调用前自建事务。
func beginTx(ex db.Commiter) (*sql.Tx, bool, error) {
	if tx, ok := ex.(*sql.Tx); ok {
		return tx, false, nil
	}
	tx, err := db.GetPool().Begin()
	if err != nil {
		return nil, false, err
	}
	return tx, true, nil
}

func rollbackTx(tx *sql.Tx, own bool) {
	if own {
		_ = tx.Rollback()
	}
}

// GetPendingRegisters 对应 CreditCore.getPendingRegisters：用户维度全部待对账外币。
func GetPendingRegisters(ex db.Commiter, userID string) ([]map[string]any, error) {
	return FindPendingByUser(ex, userID)
}

// GetForeignRegisters 对应 CreditCore.getForeignRegisters：用户维度全部外币登记（含已对账）。
func GetForeignRegisters(ex db.Commiter, userID string) ([]map[string]any, error) {
	return FindAllByUser(ex, userID)
}

// ===== 私有：额度真相源解析（共享池扩展点） =====

// resolveLimit 对应 CreditCore.#resolveLimit：共享池卡额度真相源改为读池。
func resolveLimit(ex db.Commiter, card map[string]any, userID string) (creditLimit, tempLimit float64, pooled bool, err error) {
	if poolID := toStr(card["share_pool_id"]); poolID != "" {
		rows, err := qRows(ex,
			`SELECT total_credit_limit, total_temp_limit
         FROM card_credit_pool
         WHERE id = ? AND user_id = ? AND is_deleted = 0`,
			poolID, userID)
		if err != nil {
			return 0, 0, false, err
		}
		if len(rows) > 0 {
			return toF(rows[0]["total_credit_limit"]), toF(rows[0]["total_temp_limit"]), true, nil
		}
	}
	return toF(card["credit_limit"]), toF(card["temp_limit"]), false, nil
}

// poolNetOwed 对应 CreditCore.#poolNetOwed：共享池全部卡的净负债之和（账本实时计算，H1 审计）。
// 口径与 #computeMonths 一致：消费按 toCNY 折算（每100外币=人民币），还款全量，
// pending 外币消费不计入（单独由 #poolPendingReserved 占用额度）。
func poolNetOwed(ex db.Commiter, poolID, userID string) (float64, error) {
	rows, err := qRows(ex,
		`SELECT COALESCE(SUM(t.net), 0) AS net FROM (
         SELECT COALESCE(fr.actual_rmb,
           a.amount * CASE WHEN a.currency = 'CNY' OR a.currency IS NULL THEN 1 ELSE a.exchange_rate / 100 END) AS net
         FROM account a
         JOIN card_base c ON a.card_id = c.id
         LEFT JOIN card_foreign_register fr ON fr.account_id = a.id AND fr.is_deleted = 0
         WHERE c.share_pool_id = ? AND c.user_id = ? AND a.is_deleted = 0 AND c.is_deleted = 0
           AND a.direction = 0 AND a.reversed_id IS NULL
           AND (a.category_id IS NULL OR a.category_id != 'CATEGORY_REPAY')
           AND (fr.status IS NULL OR fr.status != 'pending')
         UNION ALL
         SELECT -r.repay_amount AS net
         FROM card_repay r
         JOIN card_base c ON r.card_id = c.id
         WHERE c.share_pool_id = ? AND c.user_id = ? AND r.is_deleted = 0
           AND (r.account_id IS NULL OR NOT EXISTS (
             SELECT 1 FROM account a2 WHERE a2.id = r.account_id AND a2.is_deleted = 1
           ))
       ) t`,
		poolID, userID, poolID, userID)
	if err != nil {
		return 0, err
	}
	if len(rows) == 0 {
		return 0, nil
	}
	return toF(rows[0]["net"]), nil
}

// poolOverflow 对应 CreditCore.#poolOverflow：共享池溢缴款 = max(0, 池内还款 − 池内消费)。
func poolOverflow(ex db.Commiter, poolID, userID string) (float64, error) {
	net, err := poolNetOwed(ex, poolID, userID)
	if err != nil {
		return 0, err
	}
	return math.Max(0, -net), nil
}

// pendingReservedCard 对应 CreditCore.#pendingReserved：单卡 pending 外币登记占用额度之和。
func pendingReservedCard(ex db.Commiter, cardID, userID string) (float64, error) {
	rows, err := qRows(ex,
		`SELECT COALESCE(SUM(registered_rmb), 0) AS total
       FROM card_foreign_register
       WHERE card_id = ? AND user_id = ? AND status = 'pending' AND is_deleted = 0`,
		cardID, userID)
	if err != nil {
		return 0, err
	}
	if len(rows) == 0 {
		return 0, nil
	}
	return toF(rows[0]["total"]), nil
}

// poolPendingReserved 对应 CreditCore.#poolPendingReserved：共享池内全部卡 pending 占用额度之和。
func poolPendingReserved(ex db.Commiter, poolID, userID string) (float64, error) {
	rows, err := qRows(ex,
		`SELECT COALESCE(SUM(fr.registered_rmb), 0) AS total
       FROM card_foreign_register fr
       JOIN card_base c ON fr.card_id = c.id
       WHERE c.share_pool_id = ? AND c.user_id = ? AND fr.status = 'pending' AND fr.is_deleted = 0`,
		poolID, userID)
	if err != nil {
		return 0, err
	}
	if len(rows) == 0 {
		return 0, nil
	}
	return toF(rows[0]["total"]), nil
}

// loadForeignRegisters 对应 CreditCore.#loadForeignRegisters：载入某卡全部外币登记。
func loadForeignRegisters(ex db.Commiter, cardID, userID string) ([]map[string]any, error) {
	return qRows(ex,
		`SELECT * FROM card_foreign_register
       WHERE card_id = ? AND user_id = ? AND is_deleted = 0`,
		cardID, userID)
}

// ===== 私有：纯计算，从账本推导每张账单的快照（不写库） =====

// computeMonths 对应 CreditCore.#computeMonths：逐步骤复刻（含 pending 外币 skip、
// reconciled 用 actual_rmb、carryOver 还款结转、points=round(totalExpense*pointsRate)、
// minRepay=max(0,totalExpense*0.1)、Number(x.toFixed(4))→cur.Round4）。
// keep BUG-033：Number(bill_day)||15 / Number(repay_day)||25 兜底，与 SQL REPAY_DATE_SQL
// 用真实 repay_day=0 的双口径不一致，维持原样。
func computeMonths(ex db.Commiter, card map[string]any, userID string) ([]monthSnap, error) {
	cardID := toStr(card["id"])
	billDay := 15
	if v := toF(card["bill_day"]); v != 0 {
		billDay = int(v) // Number(card.bill_day) || 15
	}
	repayDay := 25
	if v := toF(card["repay_day"]); v != 0 {
		repayDay = int(v) // Number(card.repay_day) || 25
	}
	pointsRate := 1.0
	if v := toF(card["points_rate"]); v != 0 {
		pointsRate = v // parseFloat(card.points_rate) || 1
	}
	creditLimit, tempLimit, pooled, err := resolveLimit(ex, card, userID)
	if err != nil {
		return nil, err
	}

	// 1. 消费流水（account 表，direction=0，非还款分类）
	expenseRows, err := qRows(ex,
		`SELECT id, amount, currency, exchange_rate, trans_date, reversed_id
       FROM account
       WHERE card_id = ? AND user_id = ? AND is_deleted = 0
         AND direction = 0 AND (category_id IS NULL OR category_id != 'CATEGORY_REPAY')`,
		cardID, userID)
	if err != nil {
		return nil, err
	}

	// 2. 已冲正的消费 ID（避免重复计入）
	reversalFlows, err := qRows(ex,
		`SELECT reversed_id FROM account
       WHERE card_id = ? AND user_id = ? AND is_deleted = 0
         AND reversed_id IS NOT NULL AND direction = 1`,
		cardID, userID)
	if err != nil {
		return nil, err
	}
	reversedExpenseIds := map[string]bool{}
	for _, r := range reversalFlows {
		reversedExpenseIds[toStr(r["reversed_id"])] = true
	}

	// 载入该卡外币登记（痛点4）：已对账用 actual_rmb；pending 不计入账单
	regRows, err := loadForeignRegisters(ex, cardID, userID)
	if err != nil {
		return nil, err
	}
	regByAccount := map[string]map[string]any{}
	for _, r := range regRows {
		regByAccount[toStr(r["account_id"])] = r
	}

	spentByMonth := map[string]float64{}
	for _, row := range expenseRows {
		if toStr(row["reversed_id"]) != "" || reversedExpenseIds[toStr(row["id"])] {
			continue
		}
		var amt float64
		currency := toStr(row["currency"])
		if currency == "CNY" || currency == "" {
			amt = cur.ToCNY(toF(row["amount"]), currency, toF(row["exchange_rate"]))
		} else {
			reg, ok := regByAccount[toStr(row["id"])]
			if ok && toStr(reg["status"]) == "reconciled" {
				amt = toF(reg["actual_rmb"]) // 用银行实际结算人民币入账
			} else if ok && toStr(reg["status"]) == "pending" {
				continue // 未对账：不计入账单，避免用登记汇率粗暴入账
			} else {
				amt = cur.ToCNY(toF(row["amount"]), currency, toF(row["exchange_rate"])) // 历史无登记，回退
			}
		}
		if amt <= 0 {
			continue
		}
		bm := cardbill.GetBillMonthByDate(toStr(row["trans_date"]), billDay)
		spentByMonth[bm] += amt
	}

	// 3. 还款流水（card_repay 表，关联到账单月）
	repayRows, err := qRows(ex,
		`SELECT r.repay_amount, COALESCE(r.bill_month, b.bill_month) AS target_bill_month
       FROM card_repay r
       LEFT JOIN card_bill b ON r.bill_id = b.id AND b.is_deleted = 0
       LEFT JOIN account a ON r.account_id = a.id
       WHERE r.card_id = ? AND r.user_id = ? AND r.is_deleted = 0
         AND (r.account_id IS NULL OR a.is_deleted = 0)`,
		cardID, userID)
	if err != nil {
		return nil, err
	}
	repaidRawByMonth := map[string]float64{}
	currentBillMonth := cardbill.GetCurrentBillMonth()
	for _, r := range repayRows {
		// Node: r.target_bill_month || r.bill_month || currentBillMonth；
		// r.bill_month 未被 SELECT（undefined），故空值即回退当前账单月
		bm := toStr(r["target_bill_month"])
		if bm == "" {
			bm = currentBillMonth
		}
		amt := toF(r["repay_amount"])
		if amt <= 0 {
			continue
		}
		repaidRawByMonth[bm] += amt
	}

	// 4. 按月聚合（H7 溢缴款模型：全局累计净负债，netOwed 可为负，avail 反映溢缴）
	// 纳入已有账单的月份：即使本期已无流水，也要保留并归零，避免脏账单残留
	existingBills, err := qRows(ex,
		`SELECT bill_month FROM card_bill WHERE card_id = ? AND user_id = ? AND is_deleted = 0`,
		cardID, userID)
	if err != nil {
		return nil, err
	}
	monthSet := map[string]bool{}
	for k := range spentByMonth {
		monthSet[k] = true
	}
	for k := range repaidRawByMonth {
		monthSet[k] = true
	}
	for _, b := range existingBills {
		if bm := toStr(b["bill_month"]); bm != "" {
			monthSet[bm] = true
		}
	}
	allMonths := make([]string, 0, len(monthSet))
	for m := range monthSet {
		allMonths = append(allMonths, m)
	}
	sort.Strings(allMonths) // 对应 Array.from(monthSet).sort()

	// H3 审计：pending 外币消费按登记汇率折算人民币，占用可用额度（不释放），
	// 但 bill_amount 仍不含（待对账后按实际结算入账）。
	pendingReserved, err := pendingReservedCard(ex, cardID, userID)
	if err != nil {
		return nil, err
	}

	result := []monthSnap{}
	carryOver := 0.0         // 溢缴款顺延
	cumulativeExpense := 0.0 // 跨月累计消费
	cumulativeRepaid := 0.0  // 跨月累计还款
	// M1 审计：日期级比较（还款日当天不算逾期，避免晚于零点即标逾期）
	now := tim.Now()
	todayMidnight := time.Date(now.Year(), now.Month(), now.Day(), 0, 0, 0, 0, tim.Loc())

	for _, billMonth := range allMonths {
		totalExpense := spentByMonth[billMonth]
		totalRepaidThisMonth := repaidRawByMonth[billMonth]

		cumulativeExpense += totalExpense
		cumulativeRepaid += totalRepaidThisMonth

		availableRepaid := totalRepaidThisMonth + carryOver
		appliedToThisBill := math.Min(availableRepaid, totalExpense)
		// 本月溢缴（还款超过消费部分），顺延到后续月份
		carryOver = math.Max(0, availableRepaid-totalExpense)

		repaid := appliedToThisBill // 快照：该账单实际吸收的还款（截断）
		needRepay := math.Max(0, totalExpense-appliedToThisBill)
		// 该月增量净负债（不含顺延，供 aggregate 累加 Σ = 总消费 − 总还款）
		netOwedIncrement := totalExpense - totalRepaidThisMonth
		// 跨月累计净负债（含溢缴顺延；可为负 → 溢缴款提升可用额度）
		cumulativeNet := cumulativeExpense - cumulativeRepaid
		// 累计溢缴余额 = max(0, -累计净负债)，跨月不重复累计
		overflow := math.Max(0, -cumulativeNet)

		usedLimit := totalExpense // 累计消费（不被还款减少）
		// 可用额度 = 总额度 − 累计净负债 − pending 外币占用；溢缴时 > credit+temp
		availLimit := creditLimit + tempLimit - cumulativeNet - pendingReserved
		points := int(math.Round(totalExpense * pointsRate))
		minRepay := math.Max(0, totalExpense*0.1)

		billStartDate, billEndDate := cardbill.CalculateBillPeriod(billMonth, billDay)
		repayDate := cardbill.CalculateRepayDate(billMonth, repayDay)

		repayStatus := "未还款"
		if needRepay <= 0 {
			repayStatus = "已还清"
		} else if repaid > 0 {
			repayStatus = "部分还款"
		}

		isOverdue := false
		overdueDays := 0
		if needRepay > 0 && repayDate != "" {
			due := parseLocalDate(repayDate)
			if todayMidnight.After(due) {
				isOverdue = true
				// Math.ceil((todayMidnight - due) / DAY_MS)
				overdueDays = int(math.Ceil(float64(todayMidnight.Sub(due).Milliseconds()) / float64(dayMS)))
			}
		}

		core := map[string]any{
			"creditLimit": cur.Round4(creditLimit),
			"tempLimit":   cur.Round4(tempLimit),
			"usedLimit":   cur.Round4(usedLimit),
			"availLimit":  cur.Round4(availLimit),
			"billAmount":  cur.Round4(totalExpense),
			"repaid":      cur.Round4(repaid),
			"needRepay":   cur.Round4(needRepay),
			"overflow":    cur.Round4(overflow),
			"points":      points,
			"repayStatus": repayStatus,
			"isOverdue":   isOverdue,
			"overdueDays": overdueDays,
		}
		result = append(result, monthSnap{
			billMonth:      billMonth,
			creditLimit:    cur.Round4(creditLimit),
			tempLimit:      cur.Round4(tempLimit),
			usedLimit:      cur.Round4(usedLimit),
			availLimit:     cur.Round4(availLimit),
			billAmount:     cur.Round4(totalExpense),
			repaid:         cur.Round4(repaid),
			needRepay:      cur.Round4(needRepay),
			overflow:       cur.Round4(overflow),
			minRepay:       cur.Round4(minRepay),
			usedLimitOfNet: cur.Round4(netOwedIncrement),
			points:         points,
			repayStatus:    repayStatus,
			isOverdue:      isOverdue,
			overdueDays:    overdueDays,
			billStartDate:  billStartDate,
			billEndDate:    billEndDate,
			core:           core,
		})
	}

	// 共享池：可用额度 = 池总额度 − 池内全部卡净负债（账本实时，含 pending 占用），
	// 反映「两卡共享5000，A花4500剩500」。H1 审计：poolNet 从账本算，不再依赖快照先后。
	if pooled {
		poolID := toStr(card["share_pool_id"])
		poolNet, err := poolNetOwed(ex, poolID, userID)
		if err != nil {
			return nil, err
		}
		poolPending, err := poolPendingReserved(ex, poolID, userID)
		if err != nil {
			return nil, err
		}
		sharedAvail := cur.Round4(creditLimit + tempLimit - poolNet - poolPending)
		for i := range result {
			result[i].availLimit = sharedAvail
			result[i].core["availLimit"] = sharedAvail
		}
	}

	return result, nil
}
