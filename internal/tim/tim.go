// Package tim 时间口径：全站以 Asia/Shanghai 为"本地时间"（与 Node 服务器时区一致），
// 毫秒串 = Date.now()，日期字符串 = YYYY-MM-DD。
package tim

import (
	"sync"
	"time"
)

var shanghai = sync.OnceValue(func() *time.Location {
	loc, err := time.LoadLocation("Asia/Shanghai")
	if err != nil {
		return time.FixedZone("CST", 8*3600)
	}
	return loc
})

// Loc 返回上海时区。
func Loc() *time.Location { return shanghai() }

// Now 本地时间（Asia/Shanghai）。
func Now() time.Time { return time.Now().In(Loc()) }

// NowMS 毫秒时间戳字符串（Date.now().toString()）。
func NowMS() string { return NowMSString() }

// Today YYYY-MM-DD（本地）。
func Today() string { return Now().Format("2006-01-02") }

// BeijingNow 北京时区当前时间。
func BeijingNow() time.Time { return Now() }

// BeijingToday 北京时区 YYYY-MM-DD。
func BeijingToday() string { return BeijingNow().Format("2006-01-02") }

// BeijingMonth 北京时区 YYYY-MM。
func BeijingMonth() string { return BeijingNow().Format("2006-01") }

// FmtDateTime YYYY-MM-DD HH:mm:ss（本地）。
func FmtDateTime(t time.Time) string { return t.In(Loc()).Format("2006-01-02 15:04:05") }

// UTCNowString 对应 changePasswordWithCode 的 toISOString() 截断（UTC，BUG-049 维持原样）。
func UTCNowString() string { return time.Now().UTC().Format("2006-01-02 15:04:05") }
