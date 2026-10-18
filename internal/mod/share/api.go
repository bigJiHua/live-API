// Package share 复刻 src/modules/share/api/index.js（分享公开查看，无需登录）。
// Token 校验：AES-256-GCM（sec.VerifyShareToken + mw.ShareSecret，
// 对应 common/utils/shareToken.js；moment 模块的 ShareVerify/ShareGenerate 未就绪，
// 按任务约定在本包内用 mw.ShareSecret() 自行实现）。
package share

import (
	"net/http"

	"live/api/internal/srv"
)

func init() { srv.Add("share", Register) }

// Register 公开路由，无 authGuard（Node share/api/index.js 无 router.use(authGuard)）。
func Register(mux *http.ServeMux) {
	mux.HandleFunc("GET /api/v1/share/{token}", ViewShare)
	mux.HandleFunc("POST /api/v1/share/password", VerifyPassword)
}
