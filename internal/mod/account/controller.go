package account

import (
	"math"
	"net/http"

	"live/api/internal/db"
	"live/api/internal/resp"
	"live/api/internal/tim"
)

// ============================================================================
// 账务记录控制器（通用层）—— from: controller/index.js
// 仅处理只读查询、备注修改、统计。
// 写入操作（创建/更新/冲正）已拆分：借记卡 → debit.go，信用卡 → credit.go。
// ============================================================================

// GetList 获取收支列表。
// from: controller/index.js:14-65
func GetList(w http.ResponseWriter, r *http.Request) {
	uid := resp.UID(r)
	q := r.URL.Query()
	page := jsParseIntQuery(orDefault(q, "page", "1"))
	limit := jsParseIntQuery(orDefault(q, "limit", "20"))

	f := listFilters{}
	if hasQuery(q, "direction") {
		f.directionSet = true
		f.direction = jsParseIntQuery(q.Get("direction"))
	}
	if v := q.Get("categoryId"); v != "" {
		f.categoryID = v
	}
	if v := q.Get("payMethod"); v != "" {
		f.payMethod = v
	}
	if v := q.Get("startDate"); v != "" {
		f.startDate = v
	}
	if v := q.Get("endDate"); v != "" {
		f.endDate = v
	}

	rows, total, err := findAll(uid, f, page, limit)
	if err != nil {
		resp.Say(w, "获取失败", 500)
		return
	}

	if len(rows) == 0 {
		resp.JSON(w, 200, map[string]any{
			"status": 200, "message": "暂无记录",
			"data": map[string]any{
				"list": []map[string]any{},
				"pagination": map[string]any{
					"page": nanOrNil(page), "limit": nanOrNil(limit),
					"total": 0, "totalPages": 0,
				},
			},
		})
		return
	}

	resp.JSON(w, 200, map[string]any{
		"status": 200, "message": "获取成功",
		"data": map[string]any{
			"list": rows,
			"pagination": map[string]any{
				"page": nanOrNil(page), "limit": nanOrNil(limit),
				"total": total, "totalPages": totalPagesOf(total, orDefault(q, "limit", "20")),
			},
		},
	})
}

// GetByCard 根据卡片获取收支流水。
// from: controller/index.js:70-106
func GetByCard(w http.ResponseWriter, r *http.Request) {
	uid := resp.UID(r)
	q := r.URL.Query()
	cardID := q.Get("cardId")
	if cardID == "" {
		resp.Say(w, "卡片ID不能为空", 400)
		return
	}
	page := jsParseIntQuery(orDefault(q, "page", "1"))
	limit := jsParseIntQuery(orDefault(q, "limit", "20"))

	f := listFilters{}
	if hasQuery(q, "direction") {
		f.directionSet = true
		f.direction = jsParseIntQuery(q.Get("direction"))
	}
	if v := q.Get("startDate"); v != "" {
		f.startDate = v
	}
	if v := q.Get("endDate"); v != "" {
		f.endDate = v
	}

	rows, total, err := findByCardID(cardID, uid, f, page, limit)
	if err != nil {
		resp.Say(w, "获取失败", 500)
		return
	}

	resp.JSON(w, 200, map[string]any{
		"status": 200, "message": "获取成功",
		"data": map[string]any{
			"list": rows,
			"pagination": map[string]any{
				"page": nanOrNil(page), "limit": nanOrNil(limit),
				"total": total, "totalPages": totalPagesOf(total, orDefault(q, "limit", "20")),
			},
		},
	})
}

// GetById 获取单条收支详情。
// from: controller/index.js:111-123
func GetById(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	if id == "" {
		resp.Say(w, "记录id不能为空", 400)
		return
	}
	transaction, err := FindById(db.DB(), id, resp.UID(r))
	if err != nil {
		resp.Say(w, "获取失败", 500)
		return
	}
	if transaction == nil {
		resp.Say(w, "记录不存在", 404)
		return
	}
	resp.JSON(w, 200, map[string]any{"status": 200, "message": "获取成功", "data": transaction})
}

// UpdateRemark 修改收支备注（仅备注，通用）。
// from: controller/index.js:128-160
func UpdateRemark(w http.ResponseWriter, r *http.Request) {
	uid := resp.UID(r)
	b := resp.Parse(r)
	// 🔄 2026-10-13（api.md P3-7/F-C）：双路径 `const { remark } = req.body.data || req.body`
	//   ——加密客户端（APP PATCH encrypted=true）解密后 remark 在 data.remark；
	//   明文客户端（web PATCH 不加密）在 req.body.remark。原只读顶层 ⇒ 加密链路备注丢失。
	remark, ok := b.DataOrRaw()["remark"]
	if !ok {
		resp.JSON(w, 400, map[string]any{"status": 400, "message": "备注不能为空"})
		return
	}

	result, err := updateRemark(r.PathValue("id"), uid, remark)
	if err != nil {
		resp.SayErrBody(w, 500, "修改失败", err)
		return
	}
	if result == nil {
		resp.JSON(w, 404, map[string]any{"status": 404, "message": "记录不存在"})
		return
	}
	resp.JSON(w, 200, map[string]any{"status": 200, "message": "备注修改成功", "data": result})
}

// GetTransferList 获取转账明细列表（含自动同步）。
// from: controller/index.js:165-174
func GetTransferList(w http.ResponseWriter, r *http.Request) {
	uid := resp.UID(r)
	q := r.URL.Query()
	page := jsParseIntQuery(orDefault(q, "page", "1"))
	limit := jsParseIntQuery(orDefault(q, "limit", "20"))
	yearMonth := q.Get("yearMonth")

	list, total, err := getTransferList(uid, page, limit, yearMonth)
	if err != nil {
		resp.JSON(w, 400, map[string]any{"status": 400, "message": orMsg(err.Error(), "获取失败")})
		return
	}
	resp.JSON(w, 200, map[string]any{
		"status": 200, "message": "获取成功",
		"data": map[string]any{"list": list, "total": total},
	})
}

// GetMonthStats 获取本月收支统计。
// type=summary 返回总计 | type=detail 返回明细（按分类）。
// from: controller/index.js:180-216
func GetMonthStats(w http.ResponseWriter, r *http.Request) {
	uid := resp.UID(r)
	q := r.URL.Query()
	now := tim.Now()
	year := parseIntOr(q.Get("year"), now.Year())
	month := parseIntOr(q.Get("month"), int(now.Month()))
	typ := q.Get("type") // summary=总计, detail=明细

	stats, err := getMonthStats(uid, year, month)
	if err != nil {
		resp.Say(w, "获取失败", 500)
		return
	}

	// 如果传了 type=summary，只返回总计
	if typ == "summary" {
		resp.JSON(w, 200, map[string]any{"status": 200, "message": "获取成功", "data": stats})
		return
	}

	// 默认返回明细（按分类）
	income, expense, err := getStatsByCategory(uid, year, month)
	if err != nil {
		resp.Say(w, "获取失败", 500)
		return
	}

	// {...stats, categoryBreakdown: categoryStats}
	data := make(map[string]any, len(stats)+1)
	for k, v := range stats {
		data[k] = v
	}
	data["categoryBreakdown"] = map[string]any{"income": income, "expense": expense}

	resp.JSON(w, 200, map[string]any{"status": 200, "message": "获取成功", "data": data})
}

// GetCardsFlowStats 获取所有银行卡近 N 个月支出/收入笔数（按卡聚合）。
// from: controller/index.js:221-230
func GetCardsFlowStats(w http.ResponseWriter, r *http.Request) {
	uid := resp.UID(r)
	q := r.URL.Query()
	months := parseIntOr(q.Get("months"), 6)

	data, err := getCardsFlowStats(uid, float64(months))
	if err != nil {
		resp.Say(w, "获取失败", 500)
		return
	}
	resp.JSON(w, 200, map[string]any{"status": 200, "message": "获取成功", "data": data})
}

// ===== 本文件助手 =====

// parseIntOr 复刻 `parseInt(x) || def`（0 与 NaN 均回落默认值）。
func parseIntOr(s string, def int) int {
	f := jsParseIntQuery(s)
	if f == 0 || math.IsNaN(f) {
		return def
	}
	return int(f)
}

// totalPagesOf 复刻 `Math.ceil(result.total / limit)`（limit 为原始 query 字符串，JS 隐式转换）。
func totalPagesOf(total float64, limitRaw string) any {
	f, ok := jsNumStrict(limitRaw)
	if !ok {
		return nil // NaN → JSON null
	}
	return math.Ceil(total / f)
}
