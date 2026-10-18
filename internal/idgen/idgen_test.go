package idgen

// SYNC-A38（2026-10-12）：为 SYNC-A1 的 idgen 修复补单测。
// 原 alphabetURL 只有 62 字符却用 &63 取下标 ⇒ 字节值 62/63 直接越界 panic，
// 而 NanoID(50) 的触发概率约 80%。本测试是那道护栏。

import (
	"strings"
	"testing"
)

// nanoidAlphabet 是 nanoid 包 url-alphabet 的**逐字副本**（64 字符，含 - 与 _）。
// 这是 Go 端 alphabetURL 必须保持一致的单一事实源。
const nanoidAlphabet = "useandom-26T198340PX75pxJACKVERYMINDBUSHWOLF_GQZbfghjklqvwyzrict"

func TestAlphabetURLMatchesNanoid(t *testing.T) {
	if len(alphabetURL) != 64 {
		t.Fatalf("alphabetURL 长度 = %d，期望 64（否则 &63 会越界 panic）", len(alphabetURL))
	}
	if alphabetURL != nanoidAlphabet {
		t.Errorf("alphabetURL 与 nanoid url-alphabet 不一致：\n got %q\nwant %q", alphabetURL, nanoidAlphabet)
	}
}

// TestNanoIDNoPanic 高强度随机性回归：跑足够多的次数，任何越界都会 panic。
func TestNanoIDNoPanic(t *testing.T) {
	for i := 0; i < 20000; i++ {
		id := NanoID(50)
		if len(id) != 50 {
			t.Fatalf("第 %d 次 NanoID(50) 长度 = %d", i, len(id))
		}
	}
}

func TestNanoIDCharsetSubsetOfNanoid(t *testing.T) {
	for i := 0; i < 5000; i++ {
		for _, c := range NanoID(47) {
			if !strings.ContainsRune(nanoidAlphabet, c) {
				t.Fatalf("NanoID 产生了字符集外的字符 %q", c)
			}
		}
	}
}

// TestNanoIDCoversFullAlphabet 覆盖率：确保不是只用了子集（&63 全位可达）。
func TestNanoIDCoversFullAlphabet(t *testing.T) {
	seen := map[rune]bool{}
	for i := 0; i < 5000; i++ {
		for _, c := range NanoID(50) {
			seen[c] = true
		}
	}
	for _, c := range nanoidAlphabet {
		if !seen[c] {
			t.Errorf("字符 %q 从未出现（索引 %d 不可达）", c, strings.IndexRune(nanoidAlphabet, c))
		}
	}
}

func TestNanoIDLengths(t *testing.T) {
	if got := len(UserID()); got != 50 {
		t.Errorf("UserID 长度 = %d，期望 50", got)
	}
	if got := len(ShortID()); got != 47 {
		t.Errorf("ShortID 长度 = %d，期望 47", got)
	}
	if got := NanoID(0); got != "" {
		t.Errorf("NanoID(0) = %q，期望空串", got)
	}
}

// TestBillIDFormat 对应 idUtils.billId：
// yyyyMMddHHmmssSSS（4+2+2+2+2+2+3 = 17 位）+ 6 位 36 进制 = 23 位。
// （注：idUtils.js 注释里写的「25 位」与其自身实现不符，Node 实际输出 23 位，
//
//	Go 端与 Node 实现一致，本测试锁定 23。）
func TestBillIDFormat(t *testing.T) {
	seen := map[string]bool{}
	for i := 0; i < 2000; i++ {
		id := BillID()
		if len(id) != 23 {
			t.Fatalf("BillID 长度 = %d（%q），期望 23", len(id), id)
		}
		for j := 0; j < 17; j++ {
			if id[j] < '0' || id[j] > '9' {
				t.Fatalf("BillID 时间戳部分含非数字：%q", id)
			}
		}
		for _, c := range id[17:] {
			if !strings.ContainsRune(alphabet36, c) {
				t.Fatalf("BillID 后缀含 36 进制外字符 %q：%q", c, id)
			}
		}
		seen[id] = true
	}
	// 同一毫秒内也不应碰撞（2000 次里至少要有多个不同值）
	if len(seen) < 1000 {
		t.Errorf("BillID 唯一性可疑：2000 次只产生 %d 个不同值", len(seen))
	}
}
