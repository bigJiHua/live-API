// Package share 复刻 src/modules/share/api/index.js（分享公开查看，无需登录）。
// Token 校验：AES-256-GCM（sec.VerifyShareToken + mw.ShareSecret，
// 对应 common/utils/shareToken.js；moment 模块的 ShareVerify/ShareGenerate 未就绪，
// 按任务约定在本包内用 mw.ShareSecret() 自行实现）。
package share

import (
	"net/http"

	"live/api/internal/srv"
)

func init() {
	srv.Add("share", Register)
	// API 托管的公开分享页挂根路径（/api/v1 之外，对齐 Node app.js 的注册位置）
	srv.AddRoot("share-page", RegisterRoot)
}

// Register 公开路由，无 authGuard（Node share/api/index.js 无 router.use(authGuard)）。
func Register(mux *http.ServeMux) {
	mux.HandleFunc("GET /api/v1/share/{token}", ViewShare)
	mux.HandleFunc("POST /api/v1/share/password", VerifyPassword)
	// SSR 分享页 /api/v1 入口（与根路径等价；securityCheck 对 /share/ 路径放行）
	mux.HandleFunc("GET /api/v1/share/diary/detail", PageView)
}

// RegisterRoot 根路径直达：GET 页面 + POST 密码表单原生提交（不经过 SecurityCheck）。
func RegisterRoot(mux *http.ServeMux) {
	mux.HandleFunc("GET /share/diary/detail", PageView)
	mux.HandleFunc("POST /share/diary/detail", PageSubmit)
}
