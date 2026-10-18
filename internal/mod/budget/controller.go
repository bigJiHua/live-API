package budget

import (
	"net/http"

	"live/api/internal/db"
	"live/api/internal/resp"
)

// ============================================================================
// 预算控制器 —— from: controller/index.js（逐函数复刻）
// ============================================================================

// List 获取所有预算。from: controller/index.js:11-20
func List(w http.ResponseWriter, r *http.Request) {
	userID := resp.UID(r)

	budgets, err := FindAll(db.DB(), userID)
	if err != nil {
		resp.SayErrBody(w, 500, "查询失败", err)
		return
	}
	resp.JSON(w, 200, map[string]any{"status": 200, "message": "查询成功", "data": budgets})
}

// Stats 获取预算统计。from: controller/index.js:25-34
func Stats(w http.ResponseWriter, r *http.Request) {
	userID := resp.UID(r)

	stats, err := GetStats(db.DB(), userID)
	if err != nil {
		resp.SayErrBody(w, 500, "查询失败", err)
		return
	}
	resp.JSON(w, 200, map[string]any{"status": 200, "message": "查询成功", "data": stats})
}

// GetOne 获取单个预算。from: controller/index.js:39-53
func GetOne(w http.ResponseWriter, r *http.Request) {
	userID := resp.UID(r)
	id := r.PathValue("id")

	budget, err := FindById(db.DB(), id, userID)
	if err != nil {
		resp.SayErrBody(w, 500, "查询失败", err)
		return
	}
	if budget == nil {
		resp.JSON(w, 404, map[string]any{"status": 404, "message": "预算记录不存在"})
		return
	}
	resp.JSON(w, 200, map[string]any{"status": 200, "message": "查询成功", "data": budget})
}

// Create 创建预算。from: controller/index.js:58-79
func Create(w http.ResponseWriter, r *http.Request) {
	userID := resp.UID(r)
	data := resp.Parse(r).Data // Node: req.body.data

	budget, err := budgetCreate(db.DB(), userID,
		data["title"],
		data["route"],
		data["budget_type"],
		data["budget_amount"],
		data["budget_details"],
		hasKey(data, "budget_details"),
		data["cycle"],
		data["plan_date"],
	)
	if err != nil {
		resp.SayErrBody(w, 500, "创建失败", err)
		return
	}
	resp.JSON(w, 200, map[string]any{"status": 200, "message": "创建成功", "data": budget})
}

// Update 更新预算。from: controller/index.js:84-95
func Update(w http.ResponseWriter, r *http.Request) {
	userID := resp.UID(r)
	id := r.PathValue("id")

	budget, err := budgetUpdate(db.DB(), id, userID, resp.Parse(r).Data)
	if err != nil {
		resp.SayErrBody(w, 500, "更新失败", err)
		return
	}
	resp.JSON(w, 200, map[string]any{"status": 200, "message": "更新成功", "data": budget})
}

// Delete 删除预算（硬删除）。from: controller/index.js:100-114
func Delete(w http.ResponseWriter, r *http.Request) {
	userID := resp.UID(r)
	id := r.PathValue("id")

	result, err := PermanentDelete(db.DB(), id, userID)
	if err != nil {
		resp.SayErrBody(w, 500, "删除失败", err)
		return
	}
	if !result {
		resp.JSON(w, 404, map[string]any{"status": 404, "message": "预算记录不存在"})
		return
	}
	resp.JSON(w, 200, map[string]any{"status": 200, "message": "删除成功"})
}
