package card

import (
	"errors"
	"strings"
	"sync"

	"github.com/go-sql-driver/mysql"

	"live/api/internal/db"
	"live/api/internal/idgen"
	"live/api/internal/mod/creditcore"
	"live/api/internal/tim"
)

// 同银行共享额度池模型（痛点2）—— from: model/pool.js
//   - 同一银行下 N 张卡共享一个额度池（如农业银行 A/B 两卡共享 5000）
//   - 池持有 total_credit_limit / total_temp_limit
//   - 卡片挂 share_pool_id；CreditCore.#resolveLimit 读池而非卡片自身额度
//
// tableColumns 的列探测对应 Node 的 COLUMN_CACHE：迁移 016 未执行时 credit_report_merged
// 列不存在，动态剔除保证 CREATE/UPDATE 不崩（ER_BAD_FIELD_ERROR）。

// poolTable 对应 pool.js TABLE = "card_credit_pool"。
const poolTable = "card_credit_pool"

// poolNowStr 对应 CreditPool.nowStr()：本地 YYYY-MM-DD HH:mm:ss。
func poolNowStr() string { return tim.FmtDateTime(tim.Now()) }

// tableColumns 查询表当前列名集合（information_schema，进程内缓存）。
// from: pool.js:17-26
func tableColumns(table string) (map[string]bool, error) {
	if v, ok := columnCache.Load(table); ok {
		return v.(map[string]bool), nil
	}
	rows, err := qRows(db.DB(),
		"SELECT COLUMN_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?",
		table)
	if err != nil {
		return nil, err
	}
	cols := make(map[string]bool, len(rows))
	for _, r := range rows {
		cols[toStr(r["COLUMN_NAME"])] = true
	}
	columnCache.Store(table, cols)
	return cols, nil
}

// columnCache 对应 Node 的 COLUMN_CACHE Map（列结构进程内不变，读多写少）。
var columnCache sync.Map

// isDupEntry 判断 ER_DUP_ENTRY(1062)（对应 Node error.code === 'ER_DUP_ENTRY'）。
func isDupEntry(err error) bool {
	var myErr *mysql.MySQLError
	if errors.As(err, &myErr) {
		return myErr.Number == 1062
	}
	return false
}

// PoolCreate 对应 CreditPool.create（迁移 016 未执行时动态剔除 credit_report_merged 列）。
// bankID/bankName/currency/remark 传 nil 对应 Node 的 null（destructure 默认值：
// bankId=null/bankName=null/totalCreditLimit=0/totalTempLimit=0/creditReportMerged=0/currency="CNY"/remark=null）。
// from: pool.js:36-69
func PoolCreate(userID string, bankID, bankName any, totalCreditLimit, totalTempLimit float64, creditReportMerged bool, currency, remark any) (map[string]any, error) {
	id := idgen.ShortID()
	now := poolNowStr()

	cols, err := tableColumns(poolTable)
	if err != nil {
		return nil, err
	}
	hasMerged := cols["credit_report_merged"]
	insertCols := []string{
		"id", "user_id", "bank_id", "bank_name",
		"total_credit_limit", "total_temp_limit",
	}
	values := []any{
		id, userID, bankID, bankName,
		totalCreditLimit, totalTempLimit,
	}
	if hasMerged {
		insertCols = append(insertCols, "credit_report_merged")
		if creditReportMerged {
			values = append(values, 1)
		} else {
			values = append(values, 0)
		}
	}
	insertCols = append(insertCols, "currency", "remark", "create_time", "update_time", "is_deleted")
	values = append(values, currency, remark, now, now, 0)

	placeholders := strings.TrimSuffix(strings.Repeat("?, ", len(insertCols)), ", ")
	query := "INSERT INTO " + poolTable + " (" + strings.Join(insertCols, ", ") + ") VALUES (" + placeholders + ")"
	if _, err := db.DB().Exec(query, values...); err != nil {
		return nil, err
	}
	return PoolFindById(id, userID)
}

// poolUpdateFields 对应 CreditPool.update 的 allowed 映射（Object.keys 顺序）。
var poolUpdateFields = []struct{ js, db string }{
	{"bankId", "bank_id"},
	{"bankName", "bank_name"},
	{"totalCreditLimit", "total_credit_limit"},
	{"totalTempLimit", "total_temp_limit"},
	{"creditReportMerged", "credit_report_merged"},
	{"currency", "currency"},
	{"remark", "remark"},
}

// PoolUpdate 对应 CreditPool.update(id, userId, fields)：
// 改池额度后重算池内卡片（H1：syncCardBills 已自动全池扩散，只需触发任意一张即可）。
// from: pool.js:72-125
func PoolUpdate(id, userID string, fields map[string]any) (map[string]any, error) {
	// 迁移 016 未执行时 credit_report_merged 列不存在：动态剔除，保证 UPDATE 不崩
	cols, err := tableColumns(poolTable)
	if err != nil {
		return nil, err
	}
	var sets []string
	var params []any
	for _, fm := range poolUpdateFields {
		v, ok := fields[fm.js]
		if !ok {
			continue // Node `fields[key] !== undefined`（显式 null 也参与更新 → 写 NULL）
		}
		// 列不存在时跳过该字段（如 credit_report_merged 尚未迁移）
		if !cols[fm.db] {
			continue
		}
		sets = append(sets, fm.db+" = ?")
		switch fm.js {
		case "totalCreditLimit", "totalTempLimit":
			f, _ := jsNum(v) // Node Number(fields[key] || 0)（null/空 → 0）
			params = append(params, f)
		case "creditReportMerged":
			params = append(params, b2i(v)) // Node `fields[key] ? 1 : 0`
		default:
			params = append(params, sqlVal(v))
		}
	}
	if len(sets) == 0 {
		return PoolFindById(id, userID)
	}
	sets = append(sets, "update_time = ?")
	params = append(params, poolNowStr())
	params = append(params, id, userID)
	query := "UPDATE " + poolTable + " SET " + strings.Join(sets, ", ") + " WHERE id = ? AND user_id = ? AND is_deleted = 0"
	if _, err := db.DB().Exec(query, params...); err != nil {
		return nil, err
	}
	updated, err := PoolFindById(id, userID)
	if err != nil {
		return nil, err
	}

	// 改池额度后重算池内卡片（H1）；Node try/catch 仅 console.error，维持原样
	func() {
		defer func() { _ = recover() }()
		cardRows, err := qRows(db.DB(),
			"SELECT id FROM card_base WHERE share_pool_id = ? AND user_id = ? AND is_deleted = 0",
			id, userID)
		if err != nil || len(cardRows) == 0 {
			return
		}
		_ = creditcore.SyncCardBills(db.DB(), toStr(cardRows[0]["id"]), userID)
	}()

	return updated, nil
}

// PoolFindById 对应 CreditPool.findById。
// from: pool.js:127-133
func PoolFindById(id, userID string) (map[string]any, error) {
	return qRow(db.DB(),
		"SELECT * FROM "+poolTable+" WHERE id = ? AND user_id = ? AND is_deleted = 0",
		id, userID)
}

// poolFindById 包内别名（card create / executeMergeRepay 复用）。
func poolFindById(id, userID string) (map[string]any, error) { return PoolFindById(id, userID) }

// PoolFindByUser 对应 CreditPool.findByUser：
// 补充池内卡片信息 card_count（张数）与 cards（卡 id 列表），供前端展示 "N 张卡共享"。
// from: pool.js:135-157
func PoolFindByUser(userID string) ([]map[string]any, error) {
	rows, err := qRows(db.DB(),
		"SELECT * FROM "+poolTable+" WHERE user_id = ? AND is_deleted = 0 ORDER BY create_time DESC",
		userID)
	if err != nil {
		return nil, err
	}
	if len(rows) == 0 {
		return rows, nil
	}
	placeholders := strings.TrimSuffix(strings.Repeat("?, ", len(rows)), ", ")
	poolIDs := make([]any, 0, len(rows))
	for _, r := range rows {
		poolIDs = append(poolIDs, r["id"])
	}
	cardRows, err := qRows(db.DB(),
		"SELECT id, share_pool_id FROM card_base WHERE user_id = ? AND share_pool_id IN ("+placeholders+") AND is_deleted = 0",
		append([]any{userID}, poolIDs...)...)
	if err != nil {
		return nil, err
	}
	byPool := map[string][]any{}
	for _, c := range cardRows {
		pid := toStr(c["share_pool_id"])
		byPool[pid] = append(byPool[pid], c["id"])
	}
	out := make([]map[string]any, 0, len(rows))
	for _, r := range rows {
		m := cloneMap(r)
		cards := byPool[toStr(r["id"])]
		// 🔒 SYNC-A39：Go 的 map 未命中返回 nil []any ⇒ 序列化成 JSON null，
		// 而 Node 的 `byPool[r.id] || []` 返回空数组。前端 cards.length / .map() 会直接抛错。
		if cards == nil {
			cards = []any{}
		}
		m["card_count"] = len(cards)
		m["cards"] = cards
		out = append(out, m)
	}
	return out, nil
}

// PoolDelete 对应 CreditPool.delete：
// 事务内软删池 + 解除池内所有卡 share_pool_id；事务外重算被解绑卡（H1）。
// fix BUG-053：补校验池行 affectedRows（Node 恒返回 true，删不存在的池也返回成功）。
// from: pool.js:159-195
func PoolDelete(id, userID string) (bool, error) {
	tx, err := db.GetPool().Begin()
	if err != nil {
		return false, err
	}
	committed := false
	defer func() {
		if !committed {
			_ = tx.Rollback()
		}
	}()
	cardRows, err := qRows(tx,
		"SELECT id FROM card_base WHERE share_pool_id = ? AND user_id = ? AND is_deleted = 0",
		id, userID)
	if err != nil {
		return false, err
	}
	unboundCards := make([]string, 0, len(cardRows))
	for _, c := range cardRows {
		unboundCards = append(unboundCards, toStr(c["id"]))
	}
	// fix BUG-053：删除不存在的池时 affectedRows = 0 → 返回 false（controller 404）
	res, err := tx.Exec(
		"UPDATE "+poolTable+" SET is_deleted = 1, update_time = ? WHERE id = ? AND user_id = ?",
		poolNowStr(), id, userID)
	if err != nil {
		return false, err
	}
	// 解除池内所有卡的 share_pool_id，避免聚合时找不到池却仍按0处理（P6 审计）
	if _, err := tx.Exec(
		"UPDATE card_base SET share_pool_id = NULL, update_time = ? WHERE share_pool_id = ? AND user_id = ? AND is_deleted = 0",
		poolNowStr(), id, userID); err != nil {
		return false, err
	}
	if err := tx.Commit(); err != nil {
		return false, err
	}
	committed = true
	affected, err := res.RowsAffected()
	if err != nil {
		return false, err
	}

	// 事务外：重算被解绑卡（额度真相源切换回自身额度，H1 审计）；Node try/catch 仅 console.error
	func() {
		defer func() { _ = recover() }()
		for _, cid := range unboundCards {
			_ = creditcore.SyncCardBills(db.DB(), cid, userID)
		}
	}()

	// 🔒 SYNC-A39（2026-10-12）：affectedRows 判定移到**重算之后**。
	//
	// 旧实现把 `if affected == 0 { return false }` 放在重算之前 ⇒ 重复删除同一个池时
	//（或该池已软删但仍有卡引用），事务内的解绑 UPDATE 照常提交，账单重算却被跳过
	// ⇒ 被解绑卡的 card_bill.avail_limit 停留在池口径脏值，直到下一次任意 sync 才被修正。
	// Node 无此问题（pool.js:169-193 无条件重算）。
	//
	// 现在：先重算（无条件，与 Node 一致），再据 affectedRows 返回 false 让 controller 返 404。
	// fix BUG-053 的意图（删除不存在的池要报错）得以保留。
	if affected == 0 {
		return false, nil
	}
	return true, nil
}

// PoolAssignCard 对应 CreditPool.assignCard(cardId, userId, poolId)：把某卡归入/移出池。
// poolId 为空串对应 Node 的 null（移出池）。
// from: pool.js:198-253
func PoolAssignCard(cardID, userID, poolID string) error {
	return poolAssignCard(cardID, userID, poolID)
}

// poolAssignCard 包内实现（Card.update 的池变更路径复用）。
func poolAssignCard(cardID, userID, poolID string) error {
	tx, err := db.GetPool().Begin()
	if err != nil {
		return err
	}
	committed := false
	defer func() {
		if !committed {
			_ = tx.Rollback()
		}
	}()
	oldRows, err := qRows(tx,
		"SELECT share_pool_id, bank_id FROM card_base WHERE id = ? AND user_id = ? AND is_deleted = 0 FOR UPDATE",
		cardID, userID)
	if err != nil {
		return err
	}
	if len(oldRows) == 0 {
		return errText("卡片不存在")
	}
	oldPoolID := strOrNil(oldRows[0]["share_pool_id"]) // Node `oldRows[0].share_pool_id || null`
	newPoolID := strOrNil(poolID)                      // Node `poolId || null`
	if newPoolID != nil {
		poolRows, err := qRows(tx,
			"SELECT id, bank_id FROM card_credit_pool WHERE id = ? AND user_id = ? AND is_deleted = 0",
			toStr(newPoolID), userID)
		if err != nil {
			return err
		}
		if len(poolRows) == 0 {
			return errText("共享池不存在")
		}
		// 不同银行不能交叉归池：卡与池的 bank_id 必须一致（双方都有值时校验）
		cardBankID := strOrNil(oldRows[0]["bank_id"])
		poolBankID := strOrNil(poolRows[0]["bank_id"])
		if cardBankID != nil && poolBankID != nil && cardBankID != poolBankID {
			return errText("不同银行的卡不能归入该共享池")
		}
	}
	var newPoolParam any
	if newPoolID != nil {
		newPoolParam = newPoolID
	}
	if _, err := tx.Exec(
		"UPDATE card_base SET share_pool_id = ?, update_time = ? WHERE id = ? AND user_id = ? AND is_deleted = 0",
		newPoolParam, poolNowStr(), cardID, userID); err != nil {
		return err
	}
	if err := tx.Commit(); err != nil {
		return err
	}
	committed = true

	// 事务外：重算该卡 + 旧池 + 新池相关所有卡（H1：移池必须刷新两侧）；Node try/catch 仅 console.error
	func() {
		defer func() { _ = recover() }()
		// 🔒 SYNC-A39：Node 用 `new Set([oldPoolId, newPoolId].filter(Boolean))`
		// 自动去重 ⇒ 归池到自己已在的池（old===new）时只跑 1 次全池重算。
		// 旧实现用 slice，old===new 会跑 2 次 —— 结果幂等，但把 keep BUG-036
		// 的池级 N² 聚合成本直接翻倍。
		seenPool := map[string]bool{}
		poolSet := []string{}
		for _, pid := range []any{oldPoolID, newPoolID} {
			if pid == nil {
				continue
			}
			s := toStr(pid)
			if s == "" || seenPool[s] {
				continue
			}
			seenPool[s] = true
			poolSet = append(poolSet, s)
		}
		for _, pid := range poolSet {
			poolCards, err := qRows(db.DB(),
				"SELECT id FROM card_base WHERE share_pool_id = ? AND user_id = ? AND is_deleted = 0",
				pid, userID)
			if err != nil || len(poolCards) == 0 {
				continue
			}
			_ = creditcore.SyncCardBills(db.DB(), toStr(poolCards[0]["id"]), userID) // 自动全池扩散
		}
		_ = creditcore.SyncCardBills(db.DB(), cardID, userID) // 当前卡自身（移出池后独立）
	}()
	return nil
}
