package cur

// SYNC-A38：为 SYNC-A12 的金额舍入口径修复补单测（黄金用例）。
//
// 背景：Go 的 math.Round 是「远离 0」，JS 的 Math.round 是「半值向 +∞」；
// toFixed 按规范先取绝对值再舍入。负数金额（支出/退款）下两者差 1 个末位。

import "testing"

// 用例表的期望值均按 ECMAScript 语义手算，非由本实现反推。
func TestJsRoundHalfUp(t *testing.T) {
	cases := []struct {
		in   float64
		want float64
	}{
		{0.5, 1}, {-0.5, 0}, {1.5, 2}, {-1.5, -1},
		{2.5, 3}, {-2.5, -2}, {-0.125, 0}, {-1.005, -1},
		{1.0049, 1}, {-1.0049, -1},
	}
	for _, c := range cases {
		if got := jsRound(c.in); got != c.want {
			t.Errorf("jsRound(%v) = %v，期望 %v", c.in, got, c.want)
		}
	}
}

func TestRound2(t *testing.T) {
	cases := []struct {
		in   float64
		want float64
	}{
		{1.005, 1}, {-1.005, -1}, {0.125, 0.13}, {-0.125, -0.12},
		{12.345, 12.35}, {-12.345, -12.34}, {100, 100},
	}
	for _, c := range cases {
		if got := Round2(c.in); got != c.want {
			t.Errorf("Round2(%v) = %v，期望 %v", c.in, got, c.want)
		}
	}
}

// TestToFixedNTies 取远离 0（ECMAScript：先取绝对值舍入再补负号）。
func TestToFixedNTies(t *testing.T) {
	cases := []struct {
		in   float64
		n    int
		want float64
	}{
		{-1.5, 0, -2}, {1.5, 0, 2}, {-2.5, 0, -3}, {2.5, 0, 3},
		{-0.125, 2, -0.13}, {-1.0005, 3, -1.001},
		{9.1132, 4, 9.1132}, {-9.1132, 4, -9.1132},
	}
	for _, c := range cases {
		if got := toFixedN(c.in, c.n); got != c.want {
			t.Errorf("toFixedN(%v, %d) = %v，期望 %v", c.in, c.n, got, c.want)
		}
	}
}

func TestRound4(t *testing.T) {
	cases := []struct {
		in   float64
		want float64
	}{
		{1.23456, 1.2346}, {-1.23456, -1.2346},
		{9.11319999, 9.1132}, {-9.11319999, -9.1132},
		{0, 0},
	}
	for _, c := range cases {
		if got := Round4(c.in); got != c.want {
			t.Errorf("Round4(%v) = %v，期望 %v", c.in, got, c.want)
		}
	}
}

func TestToCNY(t *testing.T) {
	cases := []struct {
		amt  float64
		cur  string
		rate float64
		want float64
	}{
		{100, "CNY", 0, 100},
		{1.005, "CNY", 0, 1},         // Math.round(100.4999…)/100
		{-1.005, "CNY", 0, -1},       // 半值向 +∞ ⇒ -1（非 -1.01）
		{100.5, "", 0, 100.5},        // 空币种走 CNY 分支
		{1, "GBP", 911.32, 9.1132},   // 1 GBP @ 911.32 = 9.1132 CNY
		{-1, "GBP", 911.32, -9.1132}, // 负向外币同样截断 4 位
		{1, "USD", 0, 0.01},          // rate=0 回落 1 ⇒ 1 外币 = 0.01 CNY
	}
	for _, c := range cases {
		if got := ToCNY(c.amt, c.cur, c.rate); got != c.want {
			t.Errorf("ToCNY(%v, %q, %v) = %v，期望 %v", c.amt, c.cur, c.rate, got, c.want)
		}
	}
}

func TestFormatCNY(t *testing.T) {
	cases := []struct {
		in   float64
		want string
	}{
		{1234.5, "1,234.50"},
		{9.1132, "9.1132"},
		{-1234.5, "-1,234.50"},
		{0, "0.00"},
		{1000000, "1,000,000.00"},
		{999.999, "999.999"},
	}
	for _, c := range cases {
		if got := FormatCNY(c.in); got != c.want {
			t.Errorf("FormatCNY(%v) = %q，期望 %q", c.in, got, c.want)
		}
	}
}

func TestJsParseFloat(t *testing.T) {
	cases := []struct {
		in   string
		want float64
	}{
		{"12.34", 12.34},
		{" 42", 42},
		{"1e3", 1000},
		{"-3.5", -3.5},
		{"abc", 0}, // NaN → 经 num() 归零（与 `parseFloat(x) || 0` 一致）
		{"", 0},
	}
	for _, c := range cases {
		if got := num(jsParseFloat(c.in)); got != c.want {
			t.Errorf("JsParseFloat(%q) = %v，期望 %v", c.in, got, c.want)
		}
	}
}
