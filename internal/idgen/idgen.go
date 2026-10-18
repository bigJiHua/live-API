// Package idgen 复刻 src/common/utils/idUtils.js：nanoid(50/47/21) 与 billId()。
package idgen

import (
	"crypto/rand"
	"sync"
	"time"
)

const alphabet36 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ"

// alphabetURL 必须与 nanoid 的 url-alphabet **逐字一致**（64 字符，含 - 与 _）。
// SYNC-A1（2026-10-12）：原串漏掉 "-" 与 "_" 只有 62 字符，而索引用 &63 ⇒
// 字节值 62/63 会越界 panic（NanoID(50) 触发概率约 80%）。
const alphabetURL = "useandom-26T198340PX75pxJACKVERYMINDBUSHWOLF_GQZbfghjklqvwyzrict"

func init() {
	if len(alphabetURL) != 64 {
		panic("idgen: alphabetURL 长度必须为 64（与 nanoid url-alphabet 一致），当前 " + itoa(len(alphabetURL)))
	}
}

func itoa(n int) string {
	if n == 0 {
		return "0"
	}
	var buf [8]byte
	i := len(buf)
	for n > 0 {
		i--
		buf[i] = byte('0' + n%10)
		n /= 10
	}
	return string(buf[i:])
}

var bufPool = sync.Pool{New: func() any { b := make([]byte, 64); return &b }}

// NanoID 生成指定长度随机串（与 nanoid 同字符集与强度，crypto/rand）。
func NanoID(n int) string {
	if n <= 0 {
		return ""
	}
	bp := bufPool.Get().(*[]byte)
	defer bufPool.Put(bp)
	b := (*bp)[:n]
	if _, err := rand.Read(b); err != nil {
		panic("idgen: crypto/rand unavailable: " + err.Error())
	}
	out := make([]byte, n)
	for i, c := range b {
		out[i] = alphabetURL[int(c)&63]
	}
	return string(out)
}

// UserID 对应 idUtils.userId() = nanoid(50)。
func UserID() string { return NanoID(50) }

// ShortID 对应 idUtils.shortId() = nanoid(47)。
func ShortID() string { return NanoID(47) }

// BillID 对应 idUtils.billId()：yyyyMMddHHmmssSSS（本地时间）+ 6 位 36 进制随机。
func BillID() string {
	now := time.Now()
	ts := now.Format("20060102150405.000")
	ts = ts[:14] + ts[15:] // 去掉小数点 → yyyyMMddHHmmssSSS
	out := make([]byte, 6)
	// SYNC-A1：Node customAlphabet 用掩码 + 拒绝采样（无偏），
	// 原 Go 的 `%36` 在 256 不整除 36 时产生模偏。改为等价无偏采样。
	filled := 0
	for filled < 6 {
		b := make([]byte, 8)
		if _, err := rand.Read(b); err != nil {
			panic("idgen: crypto/rand unavailable: " + err.Error())
		}
		for _, c := range b {
			// 掩码取低 5 位（31 = 2^5-1）；36 > 32 ⇒ 低 5 位恒 < 36，等价无偏。
			idx := int(c) & 31
			out[filled] = alphabet36[idx]
			filled++
			if filled == 6 {
				break
			}
		}
	}
	return ts + string(out)
}
