package mw

import (
	"database/sql"
	"regexp"
	"strings"
	"sync"

	"golang.org/x/crypto/bcrypt"
)

// bcryptCheck 对应 bcryptjs.compare（出错返回 false）。
func bcryptCheck(hash, plain string) bool {
	if hash == "" || plain == "" {
		return false
	}
	return bcrypt.CompareHashAndPassword([]byte(hash), []byte(plain)) == nil
}

// BcryptHash 对应 bcryptjs.hash（cost=10）。
func BcryptHash(plain string, rounds int) (string, error) {
	if rounds < 4 || rounds > 31 {
		rounds = 10
	}
	b, err := bcrypt.GenerateFromPassword([]byte(plain), rounds)
	return string(b), err
}

// CheckPwd 对应 bcryptjs.compare（异常/空值返回 false）。
func CheckPwd(hash, plain string) bool { return bcryptCheck(hash, plain) }

func rowsAffected(res sql.Result) int64 {
	n, _ := res.RowsAffected()
	return n
}

func lastInsertID(res sql.Result) (int64, error) {
	return res.LastInsertId()
}

var (
	reCache   = map[string]*regexp.Regexp{}
	reCacheMu sync.Mutex
)

func compileRegexpCache(pattern string) (*regexp.Regexp, error) {
	reCacheMu.Lock()
	defer reCacheMu.Unlock()
	if re, ok := reCache[pattern]; ok {
		return re, nil
	}
	re, err := regexp.Compile(pattern)
	if err != nil {
		return nil, err
	}
	reCache[pattern] = re
	return re, nil
}

// MatchProtected 供外部（srv）在注册期构建路由表使用；匹配逻辑同 pinSecurityGuard。
func matchProtected(method, path string) bool { return MatchProtected(method, path) }

// RegisterRouteVerify 供 security 模块登记 route-verify 路由模式。
func RegisterRouteVerify(pattern string) {
	RegisterProtectedRoute("POST", pattern)
}

var _ = strings.ToUpper
