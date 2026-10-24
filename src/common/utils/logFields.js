/**
 * 审计日志字段的**服务端可信采集**（安全整改 P1-15 / P1-10，2026-10-08）
 *
 * ## 背景
 * `UserLog.append()` 的 INSERT 虽然是参数化的（**无 SQL 注入**），但它会按固定键名读取
 * `login_ip / login_location / login_isp / user_agent / os_info / browser_info /
 *   device_model / fingerprint / viewport / pixel_ratio / path / login_lang`。
 *
 * 旧代码多处写成 `{ user_id, type, ...clientData }` —— 把客户端传来的**整个 body** 展开进去。
 * 客户端只要在请求里塞进这些同名键，就 able to **伪造审计日志**：
 * 把真实 IP 换成别的、把 path 改成 `/admin`、把 fingerprint 冒用成受害者的值。
 * 审计日志一旦可被当事人篡改，就失去取证价值。
 *
 * ## 现在所有调用点都改走这里，除登录地点/运营商外，字段只来自服务端
 * | 字段 | 来源 |
 * |---|---|
 * | user_id | 服务端查出的用户 id |
 * | login_ip | `req.security.ip`（securityCheck 已做 `net.isIP` 校验）→ 兜底 `req.ip` |
 * | user_agent / os_info / device_model | 请求头 |
 * | fingerprint / viewport / pixel_ratio | 安全头（`x-fingerprint-hash` 等） |
 * | path | `req.path`（**服务端路由**，客户端无法伪造） |
 * | login_lang | `accept-language` |
 * | login_location / login_isp | **客户端上报（仅展示，可伪造）** —— 2026-10-20 负责人拍板的唯一例外 |
 * | browser_info | 固定占位 |
 *
 * 登录地点/运营商之所以破例：部署方可能没有服务端 IP 库，内网访问时服务端拿到的
 * 客户端 IP（192.168.x）任何 IP 库都查不出城市。这两个字段只可用于界面展示，
 * **不得参与风控、审计定性或任何权限判断**。
 */

/** 客户端上报的展示型字段：只接受字符串；空/占位值视为未上报。 */
function clientReportedText(v) {
  const s = typeof v === "string" ? v.trim() : "";
  if (!s || s === "--" || s.toLowerCase() === "unknown") return "";
  return s.slice(0, 255);
}

/** 从服务端可信来源采集日志字段（登录地点/运营商除外）。 */
function buildServerSideLogFields(req, userId) {
  const h = (req && req.headers) || {};
  const security = (req && req.security) || {};
  // 解密中间件已把客户端上下文平铺到 req.body 顶层；明文请求/未上报时为 undefined。
  const body = (req && req.body) || {};
  return {
    user_id: userId,
    // 优先用 securityCheck 校验过的 ip；无该中间件时回退 express 解析出的 req.ip
    login_ip: security.ip || (req && req.ip) || "0.0.0.0",
    user_agent: h["user-agent"] || "",
    os_info: [h["x-os-name"], h["x-device-model"]].filter(Boolean).join(" "),
    device_model: h["x-device-model"] || "",
    fingerprint: security.fingerprint || h["x-fingerprint-hash"] || "",
    viewport: [h["viewportwidth"], h["viewportheight"]].filter(Boolean).join("x"),
    pixel_ratio: h["pixelratio"] || "1",
    // path 取服务端路由，客户端无法伪造
    path: (req && (req.path || req.originalUrl)) || "/",
    login_lang: String(h["accept-language"] || "zh-CN").slice(0, 16),
    // 地点/运营商接受客户端顶层上报（展示用例外）；browser_info 仍固定占位
    login_location:
      clientReportedText(body.login_location) ||
      clientReportedText(body.loginLocation) ||
      "未知",
    login_isp:
      clientReportedText(body.login_isp) ||
      clientReportedText(body.loginIsp) ||
      "未知",
    browser_info: "",
  };
}

/**
 * 邮箱脱敏：`jihua@163.com` → `j***@163.com`
 * 用于日志输出：邮箱本身也是 PII（金融级个人金融信息规范要求最小化展示）。
 */
function maskEmail(email) {
  const s = String(email || "");
  const at = s.indexOf("@");
  if (at <= 0) return s ? "***" : "";
  const name = s.slice(0, at);
  const domain = s.slice(at);
  const head = name.slice(0, 1);
  return `${head}***${domain}`;
}

/**
 * 生成对外返回的错误详情片段（安全整改 P1-10）
 *
 * ## 为什么需要
 * 业务 handler 里普遍写成 `res.status(500).json({ message, error: error.message })`，
 * 这会把**内部实现细节**（SQL 报错片段、表名、字段名、驱动错误）直接回给客户端。
 * 项目里已有 `errorHandler` 做了生产脱敏，但这些 handler 自己 `res.json` 后就 return 了，
 * **永远走不到 errorHandler**，等于绕过。
 *
 * ## 策略
 * - 生产：只回 `{ message }`（固定文案，不含内部信息），**完全不带 `error` 字段**
 *   ⇒ 前端行为零变化（前端只读 `message` / `status`）。
 * - 非生产：保留 `error` 便于本地调试。
 *
 * @param {Error} error
 * @returns {{ error?: string }}
 */
function buildErrorDetail(error) {
  if (process.env.NODE_ENV === "production") return {};
  return { error: error && error.message ? error.message : String(error) };
}

/**
 * 拼接「对外消息 + 开发期错误详情」，供 res.json 直接展开。
 * @param {string} message 对外固定文案
 * @param {Error} error
 */
function buildErrorBody(message, error) {
  return { message, ...buildErrorDetail(error) };
}

module.exports = {
  buildServerSideLogFields,
  buildErrorDetail,
  buildErrorBody,
  maskEmail,
};