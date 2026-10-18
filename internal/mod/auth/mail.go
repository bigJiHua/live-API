package auth

// 邮件发送：复刻 src/common/utils/mailer.js 的 sendVerificationEmail（nodemailer → net/smtp，
// 同参数：EMAIL_HOST/EMAIL_PORT/EMAIL_USER/EMAIL_PASS，465 走隐式 TLS，其余 STARTTLS）。
// 发送失败由调用方 catch 后仅记录（Node 行为：验证码已落库仍返回 200）。

import (
	"crypto/tls"
	"fmt"
	"net/smtp"
	"os"

	"live/api/internal/config"
)

// sendVerificationEmail 对应 mailer.sendVerificationEmail(email, code)。
func sendVerificationEmail(to, code string) error {
	host := config.Get("EMAIL_HOST", "smtp.gmail.com")
	port := config.Get("EMAIL_PORT", "587")
	user := config.Get("EMAIL_USER", "")
	pass := config.Get("EMAIL_PASS", "")
	appName := config.Get("APP_NAME", "生活管理")

	from := fmt.Sprintf("%q <%s>", appName, user)
	subject := "验证您的邮箱"
	html := `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
          <h2 style="color: #333;">邮箱验证</h2>
          <p>您好！</p>
          <p>您的验证码是：</p>
          <div style="background: #f5f5f5; padding: 15px; text-align: center; font-size: 24px; font-weight: bold; margin: 20px 0; border-radius: 5px;">
            ` + code + `
          </div>
          <p>验证码有效期为 10 分钟，请尽快使用。</p>
          <p style="color: #999; font-size: 12px;">如果这不是您的操作，请忽略此邮件。</p>
        </div>
      `
	msg := "From: " + from + "\r\n" +
		"To: " + to + "\r\n" +
		"Subject: " + subject + "\r\n" +
		"MIME-Version: 1.0\r\n" +
		"Content-Type: text/html; charset=UTF-8\r\n" +
		"\r\n" + html

	addr := fmt.Sprintf("%s:%s", host, port)
	if port == "465" {
		// secure = EMAIL_PORT == 465（隐式 TLS）
		conn, err := tls.Dial("tcp", addr, &tls.Config{ServerName: host})
		if err != nil {
			return err
		}
		defer conn.Close()
		c, err := smtp.NewClient(conn, host)
		if err != nil {
			return err
		}
		defer c.Close()
		if err := c.Auth(smtp.PlainAuth("", user, pass, host)); err != nil {
			return err
		}
		if err := c.Mail(user); err != nil {
			return err
		}
		if err := c.Rcpt(to); err != nil {
			return err
		}
		w, err := c.Data()
		if err != nil {
			return err
		}
		if _, err := w.Write([]byte(msg)); err != nil {
			return err
		}
		return w.Close()
	}
	// 587 等：STARTTLS（net/smtp SendMail 自动协商）
	return smtp.SendMail(addr, smtp.PlainAuth("", user, pass, host), user, []string{to}, []byte(msg))
}

// sendMailLogged 对应 controller 里的 try/catch：失败仅打印，不影响响应。
func sendMailLogged(to, code string) {
	if err := sendVerificationEmail(to, code); err != nil {
		fmt.Fprintf(os.Stderr, "[发送验证码] 邮件发送失败: %s, 但验证码已保存到数据库\n", err.Error())
		return
	}
	// 🔒 SYNC-004（2026-10-11）：修复 OTP 明文打日志 —— 验证码=临时凭证，邮箱=PII。
	//   对齐 Node 阶段 4：只打脱敏邮箱与结果，验证码绝不落日志。
	fmt.Fprintf(os.Stderr, "[发送验证码] 已发送至 %s\n", MaskEmail(to))
}
