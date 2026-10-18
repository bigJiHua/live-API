// Package flow 复刻 src/modules/flow/api/index.js（流水日历，桌面端新增）。
package flow

import (
	"net/http"

	"live/api/internal/mw"
	"live/api/internal/srv"
)

func init() { srv.Add("flow", Register) }

// Register 路由顺序严格同 Node src/modules/flow/api/index.js。
// 🔒 2026-10-13（api.md §11）：GET /{id} 已删（三端流水详情走 /account/{id}），与 Node 同步。
func Register(mux *http.ServeMux) {
	auth := []func(http.Handler) http.Handler{mw.AuthGuard}

	mw.Route(mux, "GET", "/api/v1/flow/calendar", auth, Calendar)
}
