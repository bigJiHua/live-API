package auth

import (
	"net/http"
	"net/http/httptest"
	"testing"

	"live/api/internal/resp"
)

func logReq(body map[string]any) *http.Request {
	r := httptest.NewRequest("POST", "/api/v1/auth/login", nil)
	return resp.WithBody(r, resp.Body{Raw: body})
}

func TestBuildServerSideLogFieldsClientLocation(t *testing.T) {
	f := BuildServerSideLogFields(logReq(map[string]any{
		"loginLocation": "China-Zhejiang-Hangzhou",
		"loginIsp":      "CMCC",
	}), "1")
	if f["login_location"] != "China-Zhejiang-Hangzhou" {
		t.Fatalf("login_location = %v", f["login_location"])
	}
	if f["login_isp"] != "CMCC" {
		t.Fatalf("login_isp = %v", f["login_isp"])
	}
}

func TestBuildServerSideLogFieldsSnakeCase(t *testing.T) {
	f := BuildServerSideLogFields(logReq(map[string]any{
		"login_location": "China-Guangdong-Shenzhen",
		"login_isp":      "--",
	}), "1")
	if f["login_location"] != "China-Guangdong-Shenzhen" {
		t.Fatalf("login_location = %v", f["login_location"])
	}
	if f["login_isp"] != "未知" {
		t.Fatalf("login_isp = %v", f["login_isp"])
	}
}

func TestBuildServerSideLogFieldsIgnoresNestedAndForgedIP(t *testing.T) {
	f := BuildServerSideLogFields(logReq(map[string]any{
		"data": map[string]any{
			"login_location": "Mars",
			"login_ip":       "1.2.3.4",
		},
		"login_ip": "1.2.3.4",
	}), "1")
	if f["login_location"] != "未知" {
		t.Fatalf("data 内的 login_location 不应采信，实际 = %v", f["login_location"])
	}
	if f["login_ip"] == "1.2.3.4" {
		t.Fatalf("login_ip 不应采信 body")
	}
}

func TestBuildServerSideLogFieldsPlaceholders(t *testing.T) {
	f := BuildServerSideLogFields(logReq(map[string]any{
		"loginLocation": "unknown",
		"loginIsp":      "",
	}), "1")
	if f["login_location"] != "未知" || f["login_isp"] != "未知" {
		t.Fatalf("占位值应落未知，实际 = %v / %v", f["login_location"], f["login_isp"])
	}
}

func TestBuildServerSideLogFieldsNoBody(t *testing.T) {
	r := httptest.NewRequest("POST", "/api/v1/auth/login", nil)
	f := BuildServerSideLogFields(r, "1")
	if f["login_location"] != "未知" {
		t.Fatalf("无 body 时应为未知，实际 = %v", f["login_location"])
	}
}
