package todo

import (
	"net/http"

	"live/api/internal/mw"
	"live/api/internal/srv"
)

func init() { srv.Add("todo", Register) }

// Register 路由顺序严格同 Node api/index.js（src/modules/todo/api/index.js，共 7 条）。
func Register(mux *http.ServeMux) {
	auth := []func(http.Handler) http.Handler{mw.AuthGuard}
	authPin := []func(http.Handler) http.Handler{mw.AuthGuard, mw.PinLockGuard}

	// ========== 待办日程 ==========

	// 创建待办
	mw.Route(mux, "POST", "/api/v1/todo", auth, Create)

	// 获取待办列表（支持筛选）
	mw.Route(mux, "GET", "/api/v1/todo/list", auth, List)

	// 日历月视图数据
	mw.Route(mux, "GET", "/api/v1/todo/calendar/month", auth, CalendarMonth)

	// 获取即将提醒的待办（未来3-5天）
	mw.Route(mux, "GET", "/api/v1/todo/reminders", auth, Reminders)

	// 获取详情
	mw.Route(mux, "GET", "/api/v1/todo/{id}", auth, Detail)

	// 更新待办
	mw.Route(mux, "PUT", "/api/v1/todo/{id}", auth, Update)

	// 删除待办
	mw.Route(mux, "DELETE", "/api/v1/todo/{id}", authPin, Delete)
	mw.Protect("DELETE", "/api/v1/todo/:id")
}
