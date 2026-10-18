// Package upload 复刻 src/modules/upload/api/index.js（文件上传，sys_attachment 表）。
package upload

import (
	"net/http"

	"live/api/internal/mw"
	"live/api/internal/srv"
)

func init() { srv.Add("upload", Register) }

// Register 路由顺序严格同 Node src/modules/upload/api/index.js。
// 所有路由均挂 authGuard；batch-delete 另挂 pinLockGuard 并声明风险模式。
// 注意：Node 的注释要求 batch-delete 必须先于 /:id 注册（express :id 会抢先匹配）；
// Go ServeMux 静态段优先于参数段，两种顺序功能等价——按任务约定 /{id} 编辑路由先注册。
func Register(mux *http.ServeMux) {
	auth := []func(http.Handler) http.Handler{mw.AuthGuard}
	authPin := []func(http.Handler) http.Handler{mw.AuthGuard, mw.PinLockGuard}

	// 单文件上传（type=image|file|video|audio, busType=avatar|post|product, busId=可选）
	mw.Route(mux, "POST", "/api/v1/upload/single", auth, Upload)
	// 多文件上传
	mw.Route(mux, "POST", "/api/v1/upload/multiple", auth, UploadMultiple)
	// 查询附件列表
	mw.Route(mux, "GET", "/api/v1/upload/list", auth, List)
	// 搜索附件（按类型和关键词）
	mw.Route(mux, "GET", "/api/v1/upload/search", auth, Search)
	// 编辑附件（修改 remark 和 tags）
	mw.Route(mux, "POST", "/api/v1/upload/{id}", auth, Edit)
	// 批量删除附件
	mw.Route(mux, "POST", "/api/v1/upload/batch-delete", authPin, BatchDelete)
	mw.Protect("POST", "/api/v1/upload/batch-delete")
}
