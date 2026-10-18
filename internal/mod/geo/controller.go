package geo

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"regexp"
	"strconv"
	"strings"
	"time"

	"live/api/internal/mw"
	"live/api/internal/resp"
)

// ============================================================================
// 地理位置代理控制器 —— from: modules/geo/controller/index.js
// 将第三方 API 调用收口到服务端，Key 不暴露给前端。
// ============================================================================

// httpClient 对应 axios 的 timeout: 5000。
var httpClient = &http.Client{Timeout: 5 * time.Second}

// ================================================================
// 内部工具
// ================================================================

var asnRe = regexp.MustCompile(`^AS\d+`)

// extractAsn 从 org 字段提取 ASN。
func extractAsn(org string) string {
	if org == "" {
		return ""
	}
	if m := asnRe.FindString(org); m != "" {
		return m
	}
	return ""
}

// extractIsp 从 org 字段提取 ISP 名称。
func extractIsp(org string) string {
	if org == "" {
		return ""
	}
	return regexp.MustCompile(`^AS\d+\s*`).ReplaceAllString(org, "")
}

// getCenterFromRectangle 从高德 rectangle 提取中心点。
func getCenterFromRectangle(rectangle string) (lat, lng any) {
	if rectangle == "" {
		return nil, nil
	}
	parts := strings.Split(rectangle, ";")
	if len(parts) != 2 {
		return nil, nil
	}
	p0 := strings.Split(parts[0], ",")
	p1 := strings.Split(parts[1], ",")
	if len(p0) != 2 || len(p1) != 2 {
		return nil, nil
	}
	lng1, err1 := strconv.ParseFloat(strings.TrimSpace(p0[0]), 64)
	lat1, err2 := strconv.ParseFloat(strings.TrimSpace(p0[1]), 64)
	lng2, err3 := strconv.ParseFloat(strings.TrimSpace(p1[0]), 64)
	lat2, err4 := strconv.ParseFloat(strings.TrimSpace(p1[1]), 64)
	if err1 != nil || err2 != nil || err3 != nil || err4 != nil {
		return nil, nil
	}
	return (lat1 + lat2) / 2, (lng1 + lng2) / 2
}

// httpGetJSON GET 并解码 JSON（对应 axios.get + data）。
func httpGetJSON(rawURL string, params url.Values, headers map[string]string) (map[string]any, error) {
	if len(params) > 0 {
		rawURL = rawURL + "?" + params.Encode()
	}
	req, err := http.NewRequest(http.MethodGet, rawURL, nil)
	if err != nil {
		return nil, err
	}
	for k, v := range headers {
		req.Header.Set(k, v)
	}
	res, err := httpClient.Do(req)
	if err != nil {
		return nil, err
	}
	defer res.Body.Close()
	body, err := io.ReadAll(io.LimitReader(res.Body, 8<<20))
	if err != nil {
		return nil, err
	}
	var data map[string]any
	if err := json.Unmarshal(body, &data); err != nil {
		return nil, err
	}
	return data, nil
}

// ================================================================
// 单源请求
// ================================================================

// fetchIpSb ip.sb（可传入指定 IP 查询）。
func fetchIpSb(ip string) (map[string]any, error) {
	u := "https://api.ip.sb/geoip"
	if ip != "" {
		u = "https://api.ip.sb/geoip/" + ip
	}
	data, err := httpGetJSON(u, nil, map[string]string{"Accept": "application/json"})
	if err != nil {
		return nil, err
	}
	return map[string]any{
		"ip":          orStr(data["ip"], ip),
		"country":     orStr(data["country"], ""),
		"countryCode": orStr(data["country_code"], ""),
		"region":      orStr(data["region"], ""),
		"city":        orStr(data["city"], ""),
		"isp":         orStr(data["isp"], ""),
		"asn":         orStr(data["asn"], ""),
		"timezone":    orStr(data["timezone"], ""),
		"latitude":    orNull(data["latitude"]),
		"longitude":   orNull(data["longitude"]),
	}, nil
}

// fetchIpInfo ipinfo.io。
func fetchIpInfo() (map[string]any, error) {
	params := url.Values{}
	if tok := ipinfoToken(); tok != "" {
		params.Set("token", tok)
	}
	data, err := httpGetJSON("https://ipinfo.io", params, nil)
	if err != nil {
		return nil, err
	}
	var lat, lng any
	if loc, ok := data["loc"].(string); ok && loc != "" {
		parts := strings.Split(loc, ",")
		if len(parts) >= 1 {
			lat = orNull(toF(parts[0]))
		}
		if len(parts) >= 2 {
			lng = orNull(toF(parts[1]))
		}
	}
	org := orStr(data["org"], "")
	return map[string]any{
		"ip":          orStr(data["ip"], ""),
		"country":     orStr(data["country"], ""),
		"countryCode": orStr(data["country"], ""),
		"region":      orStr(data["region"], ""),
		"city":        orStr(data["city"], ""),
		"isp":         extractIsp(org),
		"asn":         extractAsn(org),
		"timezone":    orStr(data["timezone"], ""),
		"latitude":    lat,
		"longitude":   lng,
	}, nil
}

// fetchAmapIp 高德 IP 定位。
func fetchAmapIp(clientIp string) (province, city, adcode string, lat, lng any, err error) {
	key := amapKey()
	if key == "" {
		err = fmt.Errorf("AMAP_KEY 未配置")
		return
	}
	params := url.Values{}
	params.Set("key", key)
	params.Set("output", "JSON")
	if clientIp != "" {
		params.Set("ip", clientIp)
	}
	data, err := httpGetJSON("https://restapi.amap.com/v3/ip", params, nil)
	if err != nil {
		return
	}
	if orStr(data["status"], "") != "1" {
		err = fmt.Errorf("%s", orStr(data["info"], "高德 IP 定位失败"))
		return
	}
	p := ""
	if s, ok := data["province"].(string); ok {
		p = strings.TrimSpace(s)
	}
	c := ""
	if s, ok := data["city"].(string); ok {
		c = strings.TrimSpace(s)
	}
	if p == "" && c == "" {
		err = fmt.Errorf("高德无法定位此 IP（内网/国外）")
		return
	}
	rectangle := ""
	if s, ok := data["rectangle"].(string); ok {
		rectangle = s
	}
	lat, lng = getCenterFromRectangle(rectangle)
	return p, c, orStr(data["adcode"], ""), lat, lng, nil
}

// fetchAmapRegeo 高德逆地理编码。
func fetchAmapRegeo(lng, lat string) (map[string]any, error) {
	key := amapKey()
	if key == "" {
		return nil, fmt.Errorf("AMAP_KEY 未配置")
	}
	params := url.Values{}
	params.Set("key", key)
	params.Set("location", lng+","+lat)
	params.Set("output", "JSON")
	data, err := httpGetJSON("https://restapi.amap.com/v3/geocode/regeo", params, nil)
	if err != nil {
		return nil, err
	}
	if orStr(data["status"], "") != "1" {
		return nil, fmt.Errorf("%s", orStr(data["info"], "逆地理编码失败"))
	}
	ac := map[string]any{}
	if m, ok := data["regeocode"].(map[string]any); ok {
		if v, ok := m["addressComponent"].(map[string]any); ok {
			ac = v
		}
	}
	// 结构化省市区（高德返回 [] 空数组时防御）
	province := orStr(ac["province"], "")
	city := orStr(ac["city"], "")
	if city == "" {
		city = orStr(ac["district"], "")
	}
	district := ""
	if orStr(ac["city"], "") != "" {
		district = orStr(ac["district"], "")
	}
	addr := strings.Join([]string{province, city, district}, "")
	formatted := ""
	if m, ok := data["regeocode"].(map[string]any); ok {
		formatted = orStr(m["formatted_address"], "")
	}
	if addr == "" {
		addr = formatted
	}
	return map[string]any{
		"address":  addr,
		"province": province,
		"city":     city,
		"district": district,
	}, nil
}

// ================================================================
// 对外接口
// ================================================================

// clientIPOf 对应 req.security?.ip || req.ip || ""（取 securityCheck 注入的客户端 IP）。
// 🔒 SYNC-A34（2026-10-12）：补 req.ip 兜底（geo/controller/index.js:144,180）——
//
//	原实现只取 security.ip 且不判空，securityCheck 未注入时 clientIp 为空串
//	⇒ 内网判定失效，会带着空 IP 去查 ip.sb / 高德。
func clientIPOf(r *http.Request) string {
	if sec, ok := resp.Security(r).(map[string]any); ok {
		if ip, ok := sec["ip"].(string); ok && ip != "" {
			return ip
		}
	}
	if ip := mw.ClientIP(r); ip != "" {
		return ip
	}
	return ""
}

// GetNetworkInfo GET /api/v1/geo/network
// 获取网络信息（ip.sb 优先 → ipinfo.io 回退），用客户端真实 IP 查询。
// from: modules/geo/controller/index.js:138-168
func GetNetworkInfo(w http.ResponseWriter, r *http.Request) {
	rawIp := clientIPOf(r)
	// rawIp.replace(/^::ffff:/, "")
	clientIp := strings.TrimPrefix(rawIp, "::ffff:")
	isLan := lanRe.MatchString(clientIp)
	var queryIp string
	if !isLan {
		queryIp = clientIp // 内网→不传，让 ip.sb 用出口 IP
	}

	// 1. ip.sb
	if info, err := fetchIpSb(queryIp); err == nil {
		// 用客户端 IP 覆盖 ip.sb 返回的 IP（ip.sb 可能返回服务端 IP）
		if clientIp != "" && !isLan {
			info["ip"] = clientIp
		}
		info["source"] = "ip.sb"
		resp.JSON(w, 200, map[string]any{"status": 200, "data": info})
		return
	}

	// 2. ipinfo.io
	if info, err := fetchIpInfo(); err == nil {
		if clientIp != "" && !isLan {
			info["ip"] = clientIp
		}
		info["source"] = "ipinfo.io"
		resp.JSON(w, 200, map[string]any{"status": 200, "data": info})
		return
	}

	resp.JSON(w, 200, map[string]any{"status": 500, "message": "所有 IP 服务不可用"})
}

// GetIpLocation GET /api/v1/geo/ip —— 高德 IP 定位（内网/失败则返回空）。
// from: modules/geo/controller/index.js:174-194
func GetIpLocation(w http.ResponseWriter, r *http.Request) {
	rawIp := clientIPOf(r)
	clientIp := strings.TrimPrefix(rawIp, "::ffff:")
	isLan := lanRe.MatchString(clientIp)

	if isLan {
		resp.JSON(w, 200, map[string]any{"status": 200, "data": map[string]any{
			"address": "", "lat": nil, "lng": nil, "source": "none", "reason": "内网IP",
		}})
		return
	}

	if province, city, _, lat, lng, err := fetchAmapIp(clientIp); err == nil {
		if province != "" || city != "" {
			address := strings.Join(nonEmpty(province, city), " ")
			resp.JSON(w, 200, map[string]any{"status": 200, "data": map[string]any{
				"address": address, "lat": lat, "lng": lng, "source": "amap",
			}})
			return
		}
	}

	resp.JSON(w, 200, map[string]any{"status": 200, "data": map[string]any{
		"address": "", "lat": nil, "lng": nil, "source": "none",
	}})
}

// GetReverseGeocode GET /api/v1/geo/regeo?lng=116.397&lat=39.908
// 逆地理编码（GPS → 地址，高德优先，回退 Nominatim）。
// from: modules/geo/controller/index.js:200-233
func GetReverseGeocode(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	lng := q.Get("lng")
	lat := q.Get("lat")
	if lng == "" || lat == "" {
		resp.JSON(w, 200, map[string]any{"status": 400, "message": "缺少 lng / lat 参数"})
		return
	}

	// 高德逆地理编码
	if amapKey() != "" {
		if result, err := fetchAmapRegeo(lng, lat); err == nil {
			resp.JSON(w, 200, map[string]any{"status": 200, "data": map[string]any{
				"address": result["address"], "source": "amap",
			}})
			return
		}
	}

	// 回退 Nominatim
	params := url.Values{}
	params.Set("lat", lat)
	params.Set("lon", lng)
	params.Set("format", "json")
	params.Set("accept-language", "zh")
	if data, err := httpGetJSON("https://nominatim.openstreetmap.org/reverse", params,
		map[string]string{"Accept-Language": "zh"}); err == nil {
		address := orStr(data["display_name"], "")
		resp.JSON(w, 200, map[string]any{"status": 200, "data": map[string]any{
			"address": address, "source": "nominatim",
		}})
		return
	}
	resp.JSON(w, 200, map[string]any{"status": 200, "data": map[string]any{
		"address": "", "source": "none",
	}})
}

// ================================================================
// 助手
// ================================================================

// lanRe 对应内网 IP 正则：/^(10\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.|127\.|0\.)/
var lanRe = regexp.MustCompile(`^(10\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.|127\.|0\.)`)

// orStr 对应 `data.x || ""`（nil/空 → 空串）。
func orStr(v any, def string) string {
	switch t := v.(type) {
	case nil:
		return def
	case string:
		if t == "" {
			return def
		}
		return t
	case float64:
		return strconv.FormatFloat(t, 'f', -1, 64)
	case json.Number:
		return t.String()
	case bool:
		if t {
			return "true"
		}
		return "false"
	}
	return def
}

// orNull 对应 `x || null`（nil/0/空串 → nil）。
func orNull(v any) any {
	switch t := v.(type) {
	case nil:
		return nil
	case float64:
		if t == 0 {
			return nil
		}
		return t
	case json.Number:
		f, err := t.Float64()
		if err != nil || f == 0 {
			return nil
		}
		return f
	case string:
		if t == "" {
			return nil
		}
		if f, err := strconv.ParseFloat(t, 64); err == nil && f != 0 {
			return f
		}
		return nil
	}
	return v
}

// toF 对应 parseFloat(x) || 0。
func toF(v any) float64 {
	switch t := v.(type) {
	case float64:
		return t
	case json.Number:
		f, err := t.Float64()
		if err != nil {
			return 0
		}
		return f
	case string:
		f, err := strconv.ParseFloat(strings.TrimSpace(t), 64)
		if err != nil {
			return 0
		}
		return f
	}
	return 0
}

// nonEmpty 对应 [a, b].filter(Boolean)。
func nonEmpty(vals ...string) []string {
	out := []string{}
	for _, v := range vals {
		if v != "" {
			out = append(out, v)
		}
	}
	return out
}
