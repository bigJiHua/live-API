// 1. 环境变量必须最先加载
require("dotenv").config();

/* ================== 启动期密钥自检 ==================
 * 生产环境：密钥缺失 / 长度不足 / 仍是占位值 → 直接抛错拒绝启动（fail-fast）。
 * 开发环境：打印告警，不打断本地开发。
 * 目的：杜绝「漏配 .env → 静默回退到硬编码常量 → 签名可被离线复现」这类降级。
 * 详见 src/common/utils/secretGuard.js
 */
const { auditSecrets, isProduction } = require("./src/common/utils/secretGuard");
const weakSecrets = auditSecrets([
  "JWT_SECRET",
  { name: "SHARE_TOKEN_SECRET", fallbackTo: "JWT_SECRET" },
]);
if (weakSecrets.length) {
  const detail =
    `密钥未配置或强度不足：${weakSecrets.join("、")}。` +
    `要求 ≥ 32 位随机字符串且不能是占位值，可用 openssl rand -hex 32 生成。`;
  if (isProduction()) {
    throw new Error(`[启动中止] ${detail}（生产环境拒绝以弱密钥启动）`);
  }
  console.warn(`[security] ⚠ ${detail} 当前为开发环境，已放行；生产环境将拒绝启动。`);
}

const { securityCheck } = require("./src/common/middleware/securityCheck");
const decryptWithSecurity = require("./src/common/middleware/authSecurityData");
const {
  pinSecurityGuard,
} = require("./src/common/middleware/pinSecurityGuard");
// 安全整改 P1-28：APP 签名自检（未配置 APP_SIGN_SHA256 时守卫不启用）
const appSignatureGuard = require("./src/common/middleware/appSignatureGuard");
const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const morgan = require("morgan");
const path = require("path");

// 创建 Express 实例
const app = express();

/* ==================== 反向代理信任层数（P1-18，2026-10-08） ==================
 * ## 为什么要改
 * 原来是 `app.set("trust proxy", true)` —— 意为「信任任意层数的反代」，
 * express 会把 `X-Forwarded-For` **最左侧**的值当作 `req.ip`。
 * 而 XFF 是**客户端可自行构造的请求头**：直接访问 API（或反代没清洗该头）时，
 * 攻击者可以任意伪造 `req.ip`，连带影响：
 *   - `securityCheck.js:135` 的 IP 格式校验（可绕过）
 *   - `emailCodeRateLimit` / `accountLockCheck` / PIN 风控 等按 IP 的判定
 *   - 登录日志 / 卡片操作日志里记录的 IP（**审计日志失去真实性**，与 P1-15 同源）
 *
 * ## 现在的行为
 * 层数由 `TRUST_PROXY_HOPS` 决定（默认 1，即「前面有 1 层 nginx」）：
 *   - 1→ 只信任最近的 1 个反代，req.ip 取 XFF 中**倒数第 2**段
 *   - 0 → 完全不信任 XFF，req.ip 用 socket 源地址（直连部署时用这个）
 *   - true / "loopback" 等 express 特殊值仍可通过 env 传入
 * ⚠ 反代层数填错会导致 req.ip 变成反代自身 IP（内网访问时体现为 127.0.0.1），
 *   表现为「所有用户看起来来自同一 IP」—— 只影响记录，不影响功能。
 */
const TRUST_PROXY_RAW = String(process.env.TRUST_PROXY_HOPS ?? "1").trim();
const TRUST_PROXY_SETTING = (() => {
  if (TRUST_PROXY_RAW === "") return false;           // 显式留空 = 不信任
  if (/^\d+$/.test(TRUST_PROXY_RAW)) return Number(TRUST_PROXY_RAW);
  return TRUST_PROXY_RAW;                            // true / loopback / IP 列表等
})();
app.set("trust proxy", TRUST_PROXY_SETTING);
if (TRUST_PROXY_SETTING === false) {
  console.warn("[net] TRUST_PROXY_HOPS 留空 ⇒ 不信任 X-Forwarded-For，req.ip 为直连来源。");
}

/* ================== 小程序跳过设备验证 ================== */
// 小程序请求携带 x-xcx-skip-key 头部，匹配则跳过设备级别的安全校验
// app.use((req, res, next) => {
//   const skipKey = req.headers['x-xcx-skip-key'];
//   if (skipKey && skipKey === process.env.XCX_SKIP_KEY) {
//     req.xcxBypass = true;
//   }
//   next();
// });

// --- 中间件层 ---
// 认证 Cookie 解析（安全整改 P0-5）。必须早于 authGuard 挂载。
const { cookieParser } = require("./src/common/middleware/cookieParser");
app.use(cookieParser);

// 安全头
app.use(
  helmet({
    crossOriginResourcePolicy: { policy: "cross-origin" },
  })
);
/* CORS 来源白名单
 * - 生产环境：仅 FRONTEND_URL + CORS_EXTRA_ORIGINS（逗号分隔），不再放行内网/本机源。
 *   历史实现把 192.168.x.x / localhost 硬编码在代码里，若生产保留这些源，
 *   受害者浏览器上与本机服务同源的页面即可携带凭据发起 CSRF。
 * - 非生产环境：额外放行内网/本机调试源，保持本地联调体验不变。
 */
const devOrigins = [
  "http://192.168.1.4:5173",
  "http://192.168.1.4:5174",
  "http://192.168.0.103:5173",
  "http://192.168.0.103:5174",
  "http://localhost:5173",
  "http://localhost:5174",
  "http://127.0.0.1:5173",
  "http://127.0.0.1:5174",
];
const extraOrigins = (process.env.CORS_EXTRA_ORIGINS || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

const allowedOrigin = [
  process.env.FRONTEND_URL,
  ...extraOrigins,
  ...(isProduction() ? [] : devOrigins),
].filter(Boolean);
app.use(
  cors({
    origin: allowedOrigin,
    credentials: true, // 允许携带 cookie
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: [
      "Content-Type",
      "Authorization",
      "viewportwidth",
      "viewportheight",
      "pixelratio",
      "navigatorplatform",
      "X-Requested-With",
      "x-client-timestamp",
      "x-fingerprint-hash",
      "x-user-agent-custom",
      "x-device-model",
      "x-os-name",
      "x-device-type",
      "x-scene",
      "X-FP-ID",
      "x-route-verify-token",
      // 请求防重放一次性随机数（web 已实现；APP/webview-APP 待同步，见 CHANGELOG）
      "x-client-nonce",
      // P1-28：APP 签名自检（APP 原生端每请求上报，web 不带）
      "x-app-sign-sha256",
      // 预留：真正的请求级签名方案已按 Q4c 降维为 APK 签名自检，此头暂无代码依赖
      "x-sign",
      "x-client-ip",
    ],
  })
);
app.use(morgan(process.env.NODE_ENV === "production" ? "combined" : "dev")); // 日志

/* ================== 站点健康检查（APP「接入站点」探测用，2026-10-17） ==================
 * GET /api/health —— **不鉴权、不查库、不写库**，只证明两件事：
 *   1) 这个地址上跑着本项目的后端（`data.service === "live-finance"`）；
 *   2) HTTP 可达（APP 端据此决定是否允许保存站点 / 是否允许登录）。
 *
 * 为什么独立于 /api/v1：
 *   - 不经过 securityCheck（无需时间戳/nonce/指纹头）⇒ 手机时钟偏差不会把「能连」误判成「连不上」；
 *   - 不经过 PIN / APP 签名守卫（这两个在下方全局挂载）⇒ 运维 curl 也能用；
 *   - 无副作用 ⇒ 可被反代/监控高频探活。
 *
 * ⚠ 响应里**不要**放版本号以外的环境信息（DB/密钥/主机名），它是公开端点。
 * ⚠ APP 端 `SiteProbe` 依赖 `data.service` 这个固定值做「是不是本站点」判定，
 *   改名必须同步改 APP（APP/app/src/main/java/com/live/finance/core/net/SiteProbe.kt）。
 */
const HEALTH_SERVICE_ID = "live-finance";
let healthVersion = "";
try {
  healthVersion = String(require("./package.json").version || "");
} catch (_) {
  healthVersion = "";
}
app.get("/api/health", (req, res) => {
  res.status(200).json({
    status: 200,
    message: "ok",
    data: {
      service: HEALTH_SERVICE_ID,
      version: healthVersion,
      time: new Date().toISOString(),
    },
  });
});

app.use(express.json()); // JSON 解析
app.use(express.urlencoded({ extended: true })); // URL 编码解析
// 封装统一应答方法 res.say('话',状态码)
app.use(async (req, res, next) => {
  res.say = function (err, status) {
    // 🔒 2026-10-13（api.md P3-5）：响应头已发送（如流式响应中断）时不再写响应，
    //    否则 Node 抛 ERR_HTTP_HEADERS_SENT 未捕获异常。
    if (res.headersSent) return;
    const httpStatus = status === undefined ? 206 : status;
    const isServerError = httpStatus >= 500;
    const message =
      err instanceof Error &&
      isServerError &&
      process.env.NODE_ENV !== "development"
        ? "服务器内部错误"
        : err instanceof Error
        ? err.message
        : err;

    res.status(httpStatus).send({
      status: status,
      message,
    });
  };
  // 解密前端数据
  await decryptWithSecurity(req, res, next);
});

// --- PIN 安全验证中间件（在路由之后，拦截已认证的请求） ---
app.use(pinSecurityGuard);

// --- P1-28：APP 签名自检（APP_SIGN_SHA256 未配置时不启用；挂在解密之后，日志可用 req.security.ip） ---
app.use(appSignatureGuard);

// --- 路由层 ---
const apiRouter = require("./src/api");
app.use("/api/v1", securityCheck, apiRouter); // 【已启用】
app.use("/api/public", express.static(path.join(__dirname, "public"))); // 【已启用】

// --- 错误处理 ---
const {
  errorHandler,
  notFoundHandler,
} = require("./src/common/middleware/errorMiddleware");

// 404 处理
app.use(notFoundHandler);

// 全局错误处理
app.use(errorHandler);

// --- 启动逻辑 ---
if (require.main === module) {
  const PORT = process.env.PORT || 3001;
  // 启动服务
  app.listen(PORT, async () => {
    // 数据库连接检查
    const { getPool } = require("./src/common/config/db");
    const dbConfig = {
      host: process.env.DB_HOST || "localhost",
      port: process.env.DB_PORT || 3306,
      database: process.env.DB_NAME || "live",
      user:    process.env.DB_USER || "root",
    };
    try {
      const pool = getPool();
      const conn = await pool.getConnection();
      const [rows] = await conn.query("SELECT VERSION() AS version, NOW() AS server_time");
      conn.release();
      console.log(`🗄️  数据库连接成功: ${dbConfig.user}@${dbConfig.host}:${dbConfig.port}/${dbConfig.database}`);
      console.log(`    MySQL 版本: ${rows[0].version}  |  服务器时间: ${rows[0].server_time}`);
    } catch (err) {
      console.error(`❌ 数据库连接失败: ${err.message}`);
      console.error(`   目标: ${dbConfig.user}@${dbConfig.host}:${dbConfig.port}/${dbConfig.database}`);
    }

    // 初始化系统（始终执行：日常启动跑增量迁移，INIT_ENABLE=true 时走全量备份+同步）
    // 设置 INIT_SKIP=true 可跳过整个初始化流程，用于排查问题或紧急重启
    if (process.env.INIT_SKIP === "true") {
      console.log("⏭️ 跳过系统初始化（INIT_SKIP=true）");
    } else {
      const init = require("./src/init");
      const initResult = await init();
      // 🔒 2026-10-13（api.md P2-15）：迁移/schema 同步失败 ⇒ 拒绝启动（fail-fast）。
      //    原实现忽略 init() 返回值 ⇒ 服务带病启动：缺列/缺表时进程守护看它活着
      //    就不告警，而依赖新 schema 的接口随后全量 500（表现为"服务正常但功能全挂"）。
      //    现在 fatal 时直接 exit(1)，由 pm2/systemd/docker 的重启策略形成告警循环，
      //    修复数据库后下次重启自动恢复。紧急逃生阀：INIT_STRICT=false 强制启动。
      if (initResult?.fatal && process.env.INIT_STRICT !== "false") {
        console.error(
          "[启动中止] 系统初始化/数据库迁移失败（fatal），服务未启动。\n" +
          "          请按上方错误修复后重试；紧急情况下可设 INIT_STRICT=false 强制启动\n" +
          "          （不推荐：schema 与代码不一致将导致相关功能全部 500）。"
        );
        process.exit(1);
      }
    }

    // 分期计划入账定时扫描（静默执行，失败不影响主服务）
    // 可用 INSTALLMENT_SCAN_ENABLED=false 关闭；首次上线建议先设 INSTALLMENT_SCAN_DRY_RUN=true 观察清单
    try {
      const { start: startInstallmentCron } = require("./src/modules/recurring/cron");
      startInstallmentCron();
    } catch (e) {
      console.error("⚠️  分期定时任务注册失败:", e.message);
    }

    console.log(`🚀 服务已启动: http://localhost:${PORT}`);
    console.log(`🌍 环境: ${process.env.NODE_ENV || "dev"}`);
    console.log(`📡 API 地址: http://localhost:${PORT}/api`);
  });
}

module.exports = app;
