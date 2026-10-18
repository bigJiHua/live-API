package category

import (
	"net/http"

	"live/api/internal/resp"
)

// ============================================================================
// 分类控制器 —— from: controller/index.js
// ============================================================================

// GetList 获取分类列表（bank 类型自动初始化默认银行；收支分类首次自动初始化默认分类）。
// from: controller/index.js:11-53
func GetList(w http.ResponseWriter, r *http.Request) {
	uid := resp.UID(r)
	q := r.URL.Query()
	filters := map[string]any{}
	if v := q.Get("type"); v != "" {
		filters["type"] = v
	}

	categories, err := FindAll(uid, filters)
	if err != nil {
		resp.JSON(w, 500, map[string]any{"status": 500, "message": "获取失败", "error": err.Error()})
		return
	}

	// bank 类型：确保虚拟银行和默认银行分类已初始化（幂等，已存在则跳过）
	if filters["type"] == "bank" {
		hasBanks := false
		for _, c := range categories {
			id := toStr(c["id"])
			if id != "xxxx" && id != "yyyy" {
				hasBanks = true
				break
			}
		}
		if !hasBanks {
			if err := InitDefaultBanks(uid); err != nil {
				resp.JSON(w, 500, map[string]any{"status": 500, "message": "获取失败", "error": err.Error()})
				return
			}
			categories, err = FindAll(uid, filters)
			if err != nil {
				resp.JSON(w, 500, map[string]any{"status": 500, "message": "获取失败", "error": err.Error()})
				return
			}
		}
	}

	// 如果该类型没有分类，自动初始化默认分类
	if len(categories) == 0 && filters["type"] != "bank" {
		// 只检查收支分类是否存在（不被银行分类干扰）
		hasDefaults, err := FindAll(uid, map[string]any{})
		if err != nil {
			resp.JSON(w, 500, map[string]any{"status": 500, "message": "获取失败", "error": err.Error()})
			return
		}
		hasIncome := false
		for _, c := range hasDefaults {
			if t := toStr(c["type"]); t == "income" || t == "expense" {
				hasIncome = true
				break
			}
		}
		if !hasIncome {
			if err := CreateDefaults(uid); err != nil {
				resp.JSON(w, 500, map[string]any{"status": 500, "message": "获取失败", "error": err.Error()})
				return
			}
			categories, err = FindAll(uid, filters)
			if err != nil {
				resp.JSON(w, 500, map[string]any{"status": 500, "message": "获取失败", "error": err.Error()})
				return
			}
		}
	}

	resp.JSON(w, 200, map[string]any{"status": 200, "message": "获取成功", "data": categories})
}

// GetById 获取单个分类详情。
// from: controller/index.js:59-71
func GetById(w http.ResponseWriter, r *http.Request) {
	category, err := FindById(r.PathValue("id"), resp.UID(r))
	if err != nil {
		resp.JSON(w, 500, map[string]any{"status": 500, "message": "获取失败", "error": err.Error()})
		return
	}
	if category == nil {
		resp.JSON(w, 404, map[string]any{"status": 404, "message": "分类不存在"})
		return
	}
	resp.JSON(w, 200, map[string]any{"status": 200, "message": "获取成功", "data": category})
}

// Create 创建分类。
// from: controller/index.js:76-97
func Create(w http.ResponseWriter, r *http.Request) {
	uid := resp.UID(r)
	d := ruleData(r)
	// Node `const { name, type, iconUrl, remark } = req.body.data`（data 缺失即 TypeError → catch 500）
	if d == nil {
		resp.JSON(w, 500, map[string]any{
			"status": 500, "message": "创建失败",
			"error": "Cannot destructure property 'name' of 'req.body.data' as it is undefined.",
		})
		return
	}
	iconURL, iconURLSet := d["iconUrl"]
	remark, remarkSet := d["remark"]
	category, err := CreateModel(CategoryCreateParams{
		UserID:     uid,
		Name:       toStr(d["name"]),
		Type:       toStr(d["type"]),
		IconURL:    iconURL,
		IconURLSet: iconURLSet,
		Remark:     remark,
		RemarkSet:  remarkSet,
	})
	if err != nil {
		resp.JSON(w, 500, map[string]any{"status": 500, "message": "创建失败", "error": err.Error()})
		return
	}
	resp.JSON(w, 200, map[string]any{"status": 200, "message": "创建成功", "data": category})
}

// Update 更新分类。
// from: controller/index.js:102-121
func Update(w http.ResponseWriter, r *http.Request) {
	uid := resp.UID(r)
	id := r.PathValue("id")
	d := ruleData(r)
	if d == nil {
		resp.JSON(w, 500, map[string]any{
			"status": 500, "message": "更新失败",
			"error": "Cannot destructure property 'name' of 'req.body.data' as it is undefined.",
		})
		return
	}
	name, nameSet := d["name"]
	iconURL, iconURLSet := d["iconUrl"]
	remark, remarkSet := d["remark"]
	category, err := UpdateModel(id, uid, name, iconURL, remark, nameSet, iconURLSet, remarkSet)
	if err != nil {
		resp.JSON(w, 500, map[string]any{"status": 500, "message": "更新失败", "error": err.Error()})
		return
	}
	if category == nil {
		resp.JSON(w, 404, map[string]any{"status": 404, "message": "分类不存在"})
		return
	}
	resp.JSON(w, 200, map[string]any{"status": 200, "message": "更新成功", "data": category})
}

// Delete 删除分类（软删除）。
// keep BUG-056：删除不校验被引用（无引用检查，且未限定 type 可删 bank 行），维持原样。
// from: controller/index.js:126-139
func Delete(w http.ResponseWriter, r *http.Request) {
	result, err := DeleteModel(r.PathValue("id"), resp.UID(r))
	if err != nil {
		resp.JSON(w, 500, map[string]any{"status": 500, "message": "删除失败", "error": err.Error()})
		return
	}
	if !result {
		resp.JSON(w, 404, map[string]any{"status": 404, "message": "分类不存在"})
		return
	}
	resp.JSON(w, 200, map[string]any{"status": 200, "message": "删除成功"})
}
