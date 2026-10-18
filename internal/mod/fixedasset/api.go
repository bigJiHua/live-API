package fixedasset

import (
	"net/http"

	"live/api/internal/mw"
	"live/api/internal/resp"
	"live/api/internal/srv"
)

func init() { srv.Add("fixedAsset", Register) }

// Register 路由顺序严格同 Node api/index.js。
// 所有路由都需要认证（Node router.use(authGuard)）。
func Register(mux *http.ServeMux) {
	auth := []func(http.Handler) http.Handler{mw.AuthGuard}
	authPin := []func(http.Handler) http.Handler{mw.AuthGuard, mw.PinLockGuard}

	// ========== 固定资产 CRUD ==========

	// 获取所有固定资产（自动触发折旧巡检）
	mw.Route(mux, "GET", "/api/v1/fixedAsset/list", auth, List)

	// 获取回收站
	mw.Route(mux, "GET", "/api/v1/fixedAsset/recycle-bin", auth, RecycleBin)

	// 获取单个资产详情
	mw.Route(mux, "GET", "/api/v1/fixedAsset/{id}", auth, GetOne)

	// 创建固定资产
	// 🔒 SYNC-A42（2026-10-13）：补无尾斜杠变体。Node `router.post('/')` 在 Express
	// 非严格路由下同时匹配 `/fixedAsset` 与 `/fixedAsset/`；Go ServeMux 缺失时
	// POST /api/v1/fixedAsset 会被 301 重定向到带斜杠路径，POST 遇 301 后
	// 多数客户端改用 GET ⇒ 创建失败/405。同模块 GET/PUT/DELETE 均已注册 {id} 形式。
	mw.Route(mux, "POST", "/api/v1/fixedAsset", auth, Create)
	mw.Route(mux, "POST", "/api/v1/fixedAsset/", auth, Create)

	// 更新固定资产
	mw.Route(mux, "PUT", "/api/v1/fixedAsset/{id}", auth, Update)

	// 变更资产状态 / 恢复删除的资产（两路由形状冲突，合并分发）
	mw.Route(mux, "PUT", "/api/v1/fixedAsset/{p1}/{p2}", auth, DispatchStatusOrRestore)

	// 删除资产（软删除）
	mw.Route(mux, "DELETE", "/api/v1/fixedAsset/{id}", authPin, Delete)
	mw.Protect("DELETE", "/api/v1/fixedAsset/:id")

	// 永久删除资产
	mw.Route(mux, "DELETE", "/api/v1/fixedAsset/permanent/{id}", authPin, PermanentDelete)
	mw.Protect("DELETE", "/api/v1/fixedAsset/permanent/:id")

	// 手动触发折旧巡检
	mw.Route(mux, "POST", "/api/v1/fixedAsset/depreciate", auth, Depreciate)
}

// DispatchStatusOrRestore 消歧：Node 中 PUT /fixedAsset/:id/status 与
// PUT /fixedAsset/restore/:id 两路由形状冲突（{id}/status vs restore/{id}），
// Go ServeMux 不允许二者并存，合并为 {p1}/{p2} 后回填 PathValue 分发，端点语义不变。
func DispatchStatusOrRestore(w http.ResponseWriter, r *http.Request) {
	p1, p2 := r.PathValue("p1"), r.PathValue("p2")
	if p1 == "restore" {
		r.SetPathValue("id", p2)
		Restore(w, r)
		return
	}
	// 🔒 SYNC-A30（2026-10-12）：合并后 `PUT /fixedAsset/<任意>/<任意>` 都会命中。
	//   Node 只匹配 `:id/status` 与 `restore/:id`，其余组合一律 404。
	//   原实现缺这个校验 ⇒ `PUT /fixedAsset/foo/bar` 也会走 ChangeStatus（改状态）。
	//   补上 p2 == "status" 的硬校验，不匹配则回标准 JSON 404（与 srv.NotFound 同构）。
	if p2 != "status" {
		resp.JSON(w, 404, map[string]any{
			"code":    404,
			"message": "非法访问: " + r.Method + " " + r.URL.Path + "！",
		})
		return
	}
	r.SetPathValue("id", p1)
	ChangeStatus(w, r)
}
