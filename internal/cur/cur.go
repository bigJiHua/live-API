// Package cur 逐字复刻 src/common/utils/currency.js 的 toCNY / formatCNY。
package cur

import (
	"math"
	"strconv"
	"strings"
)

// jsParseFloat 复刻 JS parseFloat 宽松语义（空前缀数字可解析）。
func jsParseFloat(s string) float64 {
	s = strings.TrimSpace(s)
	end := 0
	seenDot := false
	seenDigit := false
	for i, c := range s {
		switch {
		case c >= '0' && c <= '9':
			seenDigit = true
			end = i + 1
		case c == '.' && !seenDot && seenDigit:
			seenDot = true
			end = i + 1
		case (c == '-' || c == '+') && i == 0:
		case (c == 'e' || c == 'E') && seenDigit:
			// 简易支持科学计数
			end = i + 1
			for j := i + 1; j < len(s); j++ {
				c2 := s[j]
				if (c2 >= '0' && c2 <= '9') || c2 == '+' || c2 == '-' {
					end = j + 1
				} else {
					break
				}
			}
		default:
			goto done
		}
	}
done:
	if !seenDigit {
		return math.NaN()
	}
	f, err := strconv.ParseFloat(s[:end], 64)
	if err != nil {
		return math.NaN()
	}
	return f
}

func num(f float64) float64 {
	if math.IsNaN(f) {
		return 0
	}
	return f
}

// jsRound 复刻 JS Math.round：半值向 **+∞** 舍入。
//
// 🔒 SYNC-A12（2026-10-12）：Go 的 math.Round 是「远离 0」，
//
//	对负数半值口径相反 —— Math.round(-1.5) = -1，math.Round(-1.5) = -2。
//	金额为负（支出/退款）时对账差 0.01，故必须用 floor(x+0.5)。
func jsRound(x float64) float64 {
	return math.Floor(x + 0.5)
}

// ToFixed6 复刻 JS Number(x).toFixed(6)：按绝对值舍入（ties 取远离 0）。
//
// 🔒 SYNC-A12：原实现多了 `diff < -0.5` 分支，但 floor 恒 ≤ scaled ⇒ diff ≥ 0，
//
//	该分支是死代码；真正错的是 `diff == 0.5 && floor < 0` 时也 floor--，
//	导致 -1.5 → -3（JS 是 -2）。
func ToFixed6(x float64) float64 { return toFixedN(x, 6) }

// ToCNY 复刻 currency.js：
// CNY/空 → Math.round(amt*100)/100；否则 (amt*rate/100) → toFixed(6) → 截断 4 位。
func ToCNY(amount float64, currency string, exchangeRate float64) float64 {
	amt := num(amount)
	if currency == "CNY" || currency == "" {
		return jsRound(amt*100) / 100
	}
	rate := num(exchangeRate)
	if rate == 0 {
		rate = 1
	}
	cny := amt * rate / 100
	cleaned := ToFixed6(cny)
	return math.Trunc(cleaned*10000) / 10000
}

// FormatCNY 复刻 formatCNY：NaN→"0.00"，4 位截断、最少 2 位、千分位。
func FormatCNY(v float64) string {
	if math.IsNaN(v) {
		return "0.00"
	}
	cleaned := ToFixed6(v)
	t := math.Trunc(cleaned*10000) / 10000
	neg := t < 0
	if neg {
		t = -t
	}
	s := strconv.FormatFloat(t, 'f', -1, 64)
	if !strings.Contains(s, ".") {
		s += ".00"
	} else {
		parts := strings.SplitN(s, ".", 2)
		if len(parts[1]) < 2 {
			parts[1] += strings.Repeat("0", 2-len(parts[1]))
		}
		s = parts[0] + "." + parts[1]
	}
	intPart, frac := s, ""
	if i := strings.Index(s, "."); i >= 0 {
		intPart, frac = s[:i], s[i:]
	}
	// 千分位
	var b strings.Builder
	n := len(intPart)
	for i, c := range intPart {
		if i > 0 && (n-i)%3 == 0 {
			b.WriteByte(',')
		}
		b.WriteRune(c)
	}
	out := b.String() + frac
	if neg {
		out = "-" + out
	}
	return out
}

// Round2 复刻 Math.round(x*100)/100（半值向 +∞，见 jsRound）。
func Round2(x float64) float64 { return jsRound(x*100) / 100 }

// toFixedN 复刻 Number(x).toFixed(n)。
//
// ECMAScript 规定 toFixed 先取绝对值再舍入、最后补负号 ⇒ 负数半值取远离 0
// （(-1.5).toFixed(0) === "-2"）。因 floor ≤ scaled，diff 恒 ≥ 0，只需处理
// diff == 0.5 时按符号选一侧：floor ≥ 0（正数侧）进位，floor < 0（负数侧）保持。
func toFixedN(x float64, n int) float64 {
	scale := math.Pow(10, float64(n))
	scaled := x * scale
	floor := math.Floor(scaled)
	diff := scaled - floor
	if diff > 0.5 || (diff == 0.5 && floor >= 0) {
		floor++
	}
	return floor / scale
}

// Round4 复刻 Number(x.toFixed(4))。
func Round4(x float64) float64 { return toFixedN(x, 4) }
