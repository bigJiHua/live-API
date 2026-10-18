package fixedasset

import (
	"net/http"

	"live/api/internal/cur"
	"live/api/internal/db"
	"live/api/internal/resp"
)

// ============================================================================
// 固定资产控制器 —— from: controller/index.js（逐函数复刻）
// ============================================================================

// List 获取所有固定资产（触发折旧巡检 + 补充计算字段）。
// from: controller/index.js:11-38
func List(w http.ResponseWriter, r *http.Request) {
	userID := resp.UID(r)

	// 触发折旧巡检
	if _, err := depreciateAll(db.DB(), userID); err != nil {
		resp.SayErrBody(w, 500, "查询失败", err)
		return
	}

	assets, err := FindAll(db.DB(), userID)
	if err != nil {
		resp.SayErrBody(w, 500, "查询失败", err)
		return
	}

	today := getCurrentDate()
	result := make([]map[string]any, 0, len(assets))
	for _, asset := range assets {
		monthsUsed := diffMonths(toStr(asset["buy_date"]), today)
		out := make(map[string]any, len(asset)+3)
		for k, v := range asset {
			out[k] = v
		}
		out["months_used"] = monthsUsed
		out["years_used"] = cur.Round2(monthsUsed / 12 * 100)
		out["depreciable_amount"] = cur.Round2((parseFloatJS(asset["buy_price"]) - parseFloatJS(asset["residual_val"])) * 100)
		result = append(result, out)
	}

	resp.JSON(w, 200, map[string]any{"status": 200, "message": "查询成功", "data": result})
}

// RecycleBin 获取回收站资产。from: controller/index.js:43-52
func RecycleBin(w http.ResponseWriter, r *http.Request) {
	userID := resp.UID(r)

	assets, err := FindDeleted(db.DB(), userID)
	if err != nil {
		resp.SayErrBody(w, 500, "查询失败", err)
		return
	}
	resp.JSON(w, 200, map[string]any{"status": 200, "message": "查询成功", "data": assets})
}

// GetOne 获取单个资产详情。from: controller/index.js:57-72
func GetOne(w http.ResponseWriter, r *http.Request) {
	userID := resp.UID(r)
	id := r.PathValue("id")

	asset, err := GetAssetDetail(db.DB(), id, userID)
	if err != nil {
		resp.SayErrBody(w, 500, "查询失败", err)
		return
	}
	if asset == nil {
		resp.JSON(w, 404, map[string]any{"status": 404, "message": "资产记录不存在"})
		return
	}
	resp.JSON(w, 200, map[string]any{"status": 200, "message": "查询成功", "data": asset})
}

// Create 创建固定资产。from: controller/index.js:77-116
func Create(w http.ResponseWriter, r *http.Request) {
	userID := resp.UID(r)
	// 🔄 2026-10-13（api.md P2-12）：双路径 `req.body.data || req.body`（本路由无 Joi 校验）。
	d := resp.Parse(r).DataOrRaw()

	info := d["info"]
	tag := d["tag"]
	imgURL := d["img_url"]
	buyPrice := d["buy_price"]
	useYears := d["use_years"]
	residualRate := d["residual_rate"]
	buyDate := d["buy_date"]

	// 校验
	if !truthyJS(info) {
		resp.JSON(w, 400, map[string]any{"status": 400, "message": "资产名称不能为空"})
		return
	}
	if !truthyJS(tag) {
		resp.JSON(w, 400, map[string]any{"status": 400, "message": "品类不能为空"})
		return
	}
	if !truthyJS(imgURL) {
		resp.JSON(w, 400, map[string]any{"status": 400, "message": "图片不能为空"})
		return
	}
	if !truthyJS(buyPrice) || parseFloatJS(buyPrice) <= 0 {
		resp.JSON(w, 400, map[string]any{"status": 400, "message": "购买价必须大于0"})
		return
	}
	if !truthyJS(useYears) || parseFloatJS(useYears) <= 0 {
		resp.JSON(w, 400, map[string]any{"status": 400, "message": "预计使用年限必须大于0"})
		return
	}
	rr := parseFloatJS(residualRate)
	if !truthyJS(residualRate) || (!isNaN(rr) && rr < 0) || (!isNaN(rr) && rr > 100) {
		resp.JSON(w, 400, map[string]any{"status": 400, "message": "残值率必须在0~100之间"})
		return
	}
	if !truthyJS(buyDate) {
		resp.JSON(w, 400, map[string]any{"status": 400, "message": "购买日期不能为空"})
		return
	}

	asset, err := createAsset(db.DB(), userID,
		info, tag, imgURL, buyPrice,
		d["secondhand_price"], useYears,
		residualRate, buyDate, d["status"])
	if err != nil {
		resp.SayErrBody(w, 500, "创建失败", err)
		return
	}
	resp.JSON(w, 200, map[string]any{"status": 200, "message": "创建成功", "data": asset})
}

// Update 更新固定资产。from: controller/index.js:121-133
func Update(w http.ResponseWriter, r *http.Request) {
	userID := resp.UID(r)
	id := r.PathValue("id")

	asset, err := updateAsset(db.DB(), id, userID, resp.Parse(r).DataOrRaw()) // 🔄 2026-10-13（api.md P2-12）：双路径
	if err != nil {
		resp.SayErrBody(w, 500, "更新失败", err)
		return
	}
	resp.JSON(w, 200, map[string]any{"status": 200, "message": "更新成功", "data": asset})
}

// ChangeStatus 变更资产状态。from: controller/index.js:138-160
func ChangeStatus(w http.ResponseWriter, r *http.Request) {
	userID := resp.UID(r)
	id := r.PathValue("id")
	// 🔄 2026-10-13（api.md P2-12）：双路径 `const { status } = req.body.data || req.body`。
	status := toStr(resp.Parse(r).DataOrRaw()["status"])

	if status == "" {
		resp.JSON(w, 400, map[string]any{"status": 400, "message": "状态不能为空"})
		return
	}

	validStatuses := []string{"using", "scrapped", "sold", "lost"}
	if indexOfStr(validStatuses, status) == -1 {
		resp.JSON(w, 400, map[string]any{"status": 400, "message": "状态只能是 using/scrapped/sold/lost"})
		return
	}

	asset, err := changeStatus(db.DB(), id, userID, status)
	if err != nil {
		resp.SayErrBody(w, 500, "变更失败", err)
		return
	}
	resp.JSON(w, 200, map[string]any{"status": 200, "message": "状态更新成功", "data": asset})
}

// Delete 删除资产（软删除）。from: controller/index.js:165-179
func Delete(w http.ResponseWriter, r *http.Request) {
	userID := resp.UID(r)
	id := r.PathValue("id")

	result, err := deleteAsset(db.DB(), id, userID)
	if err != nil {
		resp.SayErrBody(w, 500, "删除失败", err)
		return
	}
	if !result {
		resp.JSON(w, 404, map[string]any{"status": 404, "message": "资产记录不存在"})
		return
	}
	resp.JSON(w, 200, map[string]any{"status": 200, "message": "删除成功"})
}

// Restore 恢复删除的资产。from: controller/index.js:184-198
func Restore(w http.ResponseWriter, r *http.Request) {
	userID := resp.UID(r)
	id := r.PathValue("id")

	result, err := restoreAsset(db.DB(), id, userID)
	if err != nil {
		resp.SayErrBody(w, 500, "恢复失败", err)
		return
	}
	if !result {
		resp.JSON(w, 404, map[string]any{"status": 404, "message": "资产记录不存在"})
		return
	}
	resp.JSON(w, 200, map[string]any{"status": 200, "message": "恢复成功"})
}

// PermanentDelete 永久删除资产。from: controller/index.js:203-217
func PermanentDelete(w http.ResponseWriter, r *http.Request) {
	userID := resp.UID(r)
	id := r.PathValue("id")

	result, err := PermanentDeleteAsset(db.DB(), id, userID)
	if err != nil {
		resp.SayErrBody(w, 500, "删除失败", err)
		return
	}
	if !result {
		resp.JSON(w, 404, map[string]any{"status": 404, "message": "资产记录不存在"})
		return
	}
	resp.JSON(w, 200, map[string]any{"status": 200, "message": "永久删除成功"})
}

// Depreciate 手动触发折旧巡检。from: controller/index.js:222-231
func Depreciate(w http.ResponseWriter, r *http.Request) {
	userID := resp.UID(r)

	assets, err := depreciateAll(db.DB(), userID)
	if err != nil {
		resp.SayErrBody(w, 500, "折旧巡检失败", err)
		return
	}
	resp.JSON(w, 200, map[string]any{"status": 200, "message": "折旧巡检完成", "data": assets})
}
