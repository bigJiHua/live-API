package asset

import (
	"net/http"
	"strconv"

	"live/api/internal/resp"
)

// ============================================================================
// 资产控制器 —— from: controller/index.js（逐函数复刻）
// ============================================================================

// GetHomeAsset 获取首页资产数据（最新系统快照）。from: controller/index.js:11-30
func GetHomeAsset(w http.ResponseWriter, r *http.Request) {
	userID := resp.UID(r)

	snapshot, err := GetLatest(userID)
	if err != nil {
		// 🔒 SYNC-A42（2026-10-13）：改用 SayErr 做 5xx 生产脱敏。
		// Node asset/controller 的 catch 全部走 `res.json({status:500, ...buildErrorBody('查询失败', err)})`，
		// 而 buildErrorBody 在生产环境**只保留 message、剥掉 error 细节**。
		// 旧实现把 err.Error() 直接塞进 "message" ⇒ 绕过 resp.JSON 的脱敏机制
		//（它只剥 "error" 键）⇒ 生产环境 SQL 报错原文回显给客户端。
		resp.SayErr(w, err, 500)
		return
	}
	resp.JSON(w, 200, map[string]any{
		"status": 200, "message": "获取成功", "data": snapshot,
	})
}

// GetSnapshots 获取资产快照列表。from: controller/index.js:35-59
func GetSnapshots(w http.ResponseWriter, r *http.Request) {
	userID := resp.UID(r)
	q := r.URL.Query()

	limit := 30
	startDate := q.Get("startDate")
	endDate := q.Get("endDate")

	var snapshots []map[string]any
	var err error
	if startDate != "" && endDate != "" {
		snapshots, err = GetByDateRange(userID, startDate, endDate)
	} else {
		// parseInt(limit)：Node 解构默认值仅对 undefined 生效；键存在（含空串）即解析
		if v, ok := q["limit"]; ok {
			limit = jsParseInt(v[0])
		}
		snapshots, err = GetRecent(userID, limit)
	}
	if err != nil {
		// 🔒 SYNC-A42（2026-10-13）：改用 SayErr 做 5xx 生产脱敏。
		// Node asset/controller 的 catch 全部走 `res.json({status:500, ...buildErrorBody('查询失败', err)})`，
		// 而 buildErrorBody 在生产环境**只保留 message、剥掉 error 细节**。
		// 旧实现把 err.Error() 直接塞进 "message" ⇒ 绕过 resp.JSON 的脱敏机制
		//（它只剥 "error" 键）⇒ 生产环境 SQL 报错原文回显给客户端。
		resp.SayErr(w, err, 500)
		return
	}
	resp.JSON(w, 200, map[string]any{
		"status": 200, "message": "获取成功", "data": snapshots,
	})
}

// GetRegisters 获取用户登记列表。from: controller/index.js:64-83
func GetRegisters(w http.ResponseWriter, r *http.Request) {
	userID := resp.UID(r)
	q := r.URL.Query()

	registers, err := RegisterFindAll(userID, q.Get("startDate"), q.Get("endDate"))
	if err != nil {
		// 🔒 SYNC-A42（2026-10-13）：改用 SayErr 做 5xx 生产脱敏。
		// Node asset/controller 的 catch 全部走 `res.json({status:500, ...buildErrorBody('查询失败', err)})`，
		// 而 buildErrorBody 在生产环境**只保留 message、剥掉 error 细节**。
		// 旧实现把 err.Error() 直接塞进 "message" ⇒ 绕过 resp.JSON 的脱敏机制
		//（它只剥 "error" 键）⇒ 生产环境 SQL 报错原文回显给客户端。
		resp.SayErr(w, err, 500)
		return
	}
	resp.JSON(w, 200, map[string]any{
		"status": 200, "message": "获取成功", "data": registers,
	})
}

// CreateRegister 用户登记资产。from: controller/index.js:88-121
func CreateRegister(w http.ResponseWriter, r *http.Request) {
	userID := resp.UID(r)
	// 🔄 2026-10-13（api.md P2-12）：双路径 `req.body.data || req.body`——
	//    本路由无 Joi 校验，明文请求不带 data 包裹时须回退顶层取值。
	d := resp.Parse(r).DataOrRaw()

	totalAsset, hasTotalAsset := d["total_asset"]
	creditDebt, hasCreditDebt := d["credit_debt"]
	totalBalance, hasTotalBalance := d["total_balance"]

	if !hasTotalAsset || !hasCreditDebt || !hasTotalBalance {
		resp.JSON(w, 400, map[string]any{
			"status": 400, "message": "缺少必填参数：total_asset, credit_debt, total_balance",
		})
		return
	}

	assetDetails := d["asset_details"]
	if !truthyJS(assetDetails) {
		assetDetails = map[string]any{} // asset_details || {}
	}

	result, err := RegisterCreate(userID, totalAsset, creditDebt, totalBalance, assetDetails, d["remark"])
	if err != nil {
		// 🔒 SYNC-A42（2026-10-13）：改用 SayErr 做 5xx 生产脱敏。
		// Node asset/controller 的 catch 全部走 `res.json({status:500, ...buildErrorBody('查询失败', err)})`，
		// 而 buildErrorBody 在生产环境**只保留 message、剥掉 error 细节**。
		// 旧实现把 err.Error() 直接塞进 "message" ⇒ 绕过 resp.JSON 的脱敏机制
		//（它只剥 "error" 键）⇒ 生产环境 SQL 报错原文回显给客户端。
		resp.SayErr(w, err, 500)
		return
	}
	resp.JSON(w, 200, map[string]any{
		"status": 200, "message": "登记成功", "data": result,
	})
}

// UpdateRegister 更新登记记录。from: controller/index.js:126-159
func UpdateRegister(w http.ResponseWriter, r *http.Request) {
	userID := resp.UID(r)
	id := r.PathValue("id")
	// 🔄 2026-10-13（api.md P2-12）：双路径 `req.body.data || req.body`（同 CreateRegister）。
	d := resp.Parse(r).DataOrRaw()

	// Node 传入对象字面量：键缺失 = undefined（跳过更新），显式 null 写 SQL NULL
	updates := map[string]any{}
	if v, ok := d["total_asset"]; ok {
		updates["total_asset"] = v
	}
	if v, ok := d["credit_debt"]; ok {
		updates["credit_debt"] = v
	}
	if v, ok := d["total_balance"]; ok {
		updates["total_balance"] = v
	}
	if v, ok := d["asset_details"]; ok {
		updates["asset_details"] = v
	}
	if v, ok := d["remark"]; ok {
		updates["remark"] = v
	}
	result, err := RegisterUpdate(id, userID, updates)
	if err != nil {
		// 🔒 SYNC-A42（2026-10-13）：改用 SayErr 做 5xx 生产脱敏。
		// Node asset/controller 的 catch 全部走 `res.json({status:500, ...buildErrorBody('查询失败', err)})`，
		// 而 buildErrorBody 在生产环境**只保留 message、剥掉 error 细节**。
		// 旧实现把 err.Error() 直接塞进 "message" ⇒ 绕过 resp.JSON 的脱敏机制
		//（它只剥 "error" 键）⇒ 生产环境 SQL 报错原文回显给客户端。
		resp.SayErr(w, err, 500)
		return
	}
	if result == nil {
		resp.JSON(w, 404, map[string]any{"status": 404, "message": "记录不存在"})
		return
	}
	resp.JSON(w, 200, map[string]any{
		"status": 200, "message": "更新成功", "data": result,
	})
}

// DeleteRegister 删除登记记录。from: controller/index.js:164-189
func DeleteRegister(w http.ResponseWriter, r *http.Request) {
	userID := resp.UID(r)
	id := r.PathValue("id")

	success, err := RegisterDelete(id, userID)
	if err != nil {
		// 🔒 SYNC-A42（2026-10-13）：改用 SayErr 做 5xx 生产脱敏。
		// Node asset/controller 的 catch 全部走 `res.json({status:500, ...buildErrorBody('查询失败', err)})`，
		// 而 buildErrorBody 在生产环境**只保留 message、剥掉 error 细节**。
		// 旧实现把 err.Error() 直接塞进 "message" ⇒ 绕过 resp.JSON 的脱敏机制
		//（它只剥 "error" 键）⇒ 生产环境 SQL 报错原文回显给客户端。
		resp.SayErr(w, err, 500)
		return
	}
	if !success {
		resp.JSON(w, 404, map[string]any{"status": 404, "message": "记录不存在"})
		return
	}
	resp.JSON(w, 200, map[string]any{"status": 200, "message": "删除成功"})
}

// GetRegisterById 获取登记记录详情。from: controller/index.js:194-220
func GetRegisterById(w http.ResponseWriter, r *http.Request) {
	userID := resp.UID(r)
	id := r.PathValue("id")

	register, err := RegisterFindById(id, userID)
	if err != nil {
		// 🔒 SYNC-A42（2026-10-13）：改用 SayErr 做 5xx 生产脱敏。
		// Node asset/controller 的 catch 全部走 `res.json({status:500, ...buildErrorBody('查询失败', err)})`，
		// 而 buildErrorBody 在生产环境**只保留 message、剥掉 error 细节**。
		// 旧实现把 err.Error() 直接塞进 "message" ⇒ 绕过 resp.JSON 的脱敏机制
		//（它只剥 "error" 键）⇒ 生产环境 SQL 报错原文回显给客户端。
		resp.SayErr(w, err, 500)
		return
	}
	if register == nil {
		resp.JSON(w, 404, map[string]any{"status": 404, "message": "记录不存在"})
		return
	}
	resp.JSON(w, 200, map[string]any{
		"status": 200, "message": "获取成功", "data": register,
	})
}

// jsParseInt 对应 parseInt(str, 10)（宽松前缀解析；Node 失败得到 NaN，
// 此处失败返回 -1 使 LIMIT 非法从而与 Node 一样落入 SQL 错误路径）。
func jsParseInt(s string) int {
	end, seenDigit := 0, false
	for i := 0; i < len(s); i++ {
		c := s[i]
		if c >= '0' && c <= '9' {
			seenDigit = true
			end = i + 1
		} else if (c == '-' || c == '+') && i == 0 {
			// 允许前导符号
		} else {
			break
		}
	}
	if !seenDigit {
		return -1
	}
	n, err := strconv.Atoi(s[:end])
	if err != nil {
		return -1
	}
	return n
}
