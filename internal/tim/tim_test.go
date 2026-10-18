package tim

// SYNC-A38（2026-10-12）：锁定时间口径 —— 金额/时间的错位会直接污染账目。

import (
	"strconv"
	"testing"
	"time"
)

func TestBeijingToday(t *testing.T) {
	// 与 Node 的「北京时间今天」口径一致：无论服务器 TZ 如何，都按 Asia/Shanghai
	got := BeijingToday()
	if len(got) != 10 {
		t.Fatalf("BeijingToday() = %q，长度应为 10（YYYY-MM-DD）", got)
	}
	if _, err := time.ParseInLocation("2006-01-02", got, Loc()); err != nil {
		t.Errorf("BeijingToday() = %q 不是合法日期：%v", got, err)
	}
}

func TestLocIsShanghai(t *testing.T) {
	name, offset := time.Now().In(Loc()).Zone()
	if name != "Asia/Shanghai" && offset != 8*3600 {
		t.Errorf("Loc() 应为 Asia/Shanghai（+08:00），实际 name=%q offset=%d", name, offset)
	}
}

// TestNowMS NowMS 返回毫秒**字符串**（Date.now().toString()）。
func TestNowMS(t *testing.T) {
	before := time.Now().UnixMilli()
	got := NowMS()
	after := time.Now().UnixMilli()

	n, err := strconv.ParseInt(got, 10, 64)
	if err != nil {
		t.Fatalf("NowMS() = %q 不是合法整数串：%v", got, err)
	}
	if n < before-1000 || n > after+1000 {
		t.Errorf("NowMS() = %d，超出 [before=%d, after=%d] 范围", n, before, after)
	}
}

func TestNowMSString(t *testing.T) {
	s := NowMSString()
	// 与 JS 的 String(Date.now()) 同构：纯十进制数字串
	for _, c := range s {
		if c < '0' || c > '9' {
			t.Fatalf("NowMSString() = %q 含非数字字符", s)
		}
	}
	if len(s) != 13 {
		t.Errorf("NowMSString() = %q，长度应为 13（毫秒时间戳）", s)
	}
}
