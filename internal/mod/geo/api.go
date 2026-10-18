// Package geo 复刻 src/modules/geo/api/index.js（地理位置代理，Key 收口服务端）。
package geo

import (
	"net/http"

	"live/api/internal/config"
	"live/api/internal/mw"
	"live/api/internal/srv"
)

// IPINFO_TOKEN / AMAP_KEY 对应 Node 模块加载时读取的 process.env。
// 注意：.env 由 main() 的 config.Load() 在包初始化之后加载，故此处按请求惰性读取。
func ipinfoToken() string { return config.Get("IPINFO_TOKEN", "") }
func amapKey() string     { return config.Get("AMAP_KEY", "") }

func init() { srv.Add("geo", Register) }

// Register 路由顺序严格同 Node src/modules/geo/api/index.js。
// /network 无鉴权（登录前客户端上下文采集），/ip 与 /regeo 挂 authGuard。
func Register(mux *http.ServeMux) {
	auth := []func(http.Handler) http.Handler{mw.AuthGuard}

	mux.HandleFunc("GET /api/v1/geo/network", GetNetworkInfo)
	mw.Route(mux, "GET", "/api/v1/geo/ip", auth, GetIpLocation)
	mw.Route(mux, "GET", "/api/v1/geo/regeo", auth, GetReverseGeocode)
}
