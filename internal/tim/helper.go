package tim

import (
	"strconv"
	"time"
)

// NowMSString 毫秒时间戳字符串（Date.now().toString()）。
func NowMSString() string {
	return strconv.FormatInt(time.Now().UnixMilli(), 10)
}
