/**
 * API 托管的公开分享页 —— 服务端渲染（SSR）版
 *
 * GET  /share/diary/detail?token=…  token 模式：校验后直接拼好完整 HTML 返回
 * GET  /share/diary/detail?id=…     密码模式：返回原生 <form> 密码页
 * POST /share/diary/detail          密码模式表单提交（浏览器原生提交，无 JS）
 *
 * 设计要点：
 * - 页面零 JavaScript：无 <script> 标签，且 CSP `script-src 'none'` 兜底，
 *   即使正文内嵌任何脚本/事件处理器也不会在访客浏览器执行。
 * - 正文为分享者本人所写（自部署单用户），不做服务端富文本消毒，按用户决策注入原文；
 *   作者/心情/位置/错误提示等纯文本字段一律 escapeHtml，防止破坏页面结构。
 * - 密码防爆破复用 controller/index.js 的 verifyPassword（同一内存 tracker、同一规则），
 *   通过包装 res 捕获其 JSON 结果后转为 HTML 渲染。
 * - Cache-Control: no-store（内容随查询参数变化且属私有内容）。
 */

const { verifyShareToken } = require("../../../common/utils/shareToken");
const Moment = require("../../moment/model");
const User = require("../../auth/model/user");
const { verifyPassword } = require("./index");

/* ────────────── 工具 ────────────── */

const escapeHtml = (val) =>
  String(val ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");

const safeJsonParse = (val, fallback = null) => {
  if (!val) return fallback;
  try {
    return JSON.parse(val);
  } catch {
    return fallback;
  }
};

const pad2 = (n) => String(n).padStart(2, "0");

const formatTime = (ts) => {
  const ms = Number(ts);
  if (!ts || Number.isNaN(ms)) return "";
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
};

const expireText = (expireAt) => {
  if (!expireAt) return "";
  const diff = new Date(expireAt).getTime() - Date.now();
  if (diff <= 0) return "已过期";
  const hours = Math.floor(diff / 3600000);
  const mins = Math.floor((diff % 3600000) / 60000);
  if (hours > 24) return `分享链接 ${Math.floor(hours / 24)}天后过期`;
  if (hours > 0) return `分享链接 ${hours}小时后过期`;
  return `分享链接 ${mins}分钟后过期`;
};

/** 相对上传路径 → 同源完整 URL（绝对地址原样返回） */
const resolveImg = (url) => {
  const u = String(url || "");
  if (!u) return "";
  if (/^https?:\/\//i.test(u)) return u;
  if (u.startsWith("/api/public/")) return u;
  return "/api/public" + (u.startsWith("/") ? u : "/" + u);
};

/* ────────────── HTML 模板 ────────────── */

const CSP = [
  "default-src 'self'",
  "script-src 'none'", // 页面零 JS：即使正文被注入脚本也无法执行
  "style-src 'self' 'unsafe-inline'", // 正文富文本携带 style 属性（wangEditor）
  "img-src 'self' data: http: https:",
  "connect-src 'none'",
  "base-uri 'none'",
  "frame-ancestors 'none'",
  "form-action 'self'",
].join("; ");

const html = (res, status, body) => {
  res.set({
    "Content-Type": "text/html; charset=utf-8",
    "Content-Security-Policy": CSP,
    "Cache-Control": "no-store",
    "Referrer-Policy": "no-referrer",
  });
  return res.status(status).send(body);
};

const AVATAR_SVG =
  '<svg class="avatar" viewBox="0 0 40 40"><rect width="40" height="40" rx="20" fill="#e8e8e8"/><circle cx="20" cy="14" r="8" fill="#c0c0c0"/><ellipse cx="20" cy="36" rx="15" ry="10" fill="#c0c0c0"/></svg>';

const LOCK_SVG =
  '<svg viewBox="0 0 48 48" fill="none"><rect x="9" y="21" width="30" height="21" rx="4" fill="#1989fa" opacity="0.15"/><rect x="9" y="21" width="30" height="21" rx="4" stroke="#1989fa" stroke-width="3"/><path d="M16 21v-4a8 8 0 0 1 16 0v4" stroke="#1989fa" stroke-width="3" stroke-linecap="round"/><circle cx="24" cy="30" r="2.5" fill="#1989fa"/><path d="M24 32v4" stroke="#1989fa" stroke-width="3" stroke-linecap="round"/></svg>';

const PAGE_STYLE = `
    * { margin: 0; padding: 0; box-sizing: border-box; -webkit-tap-highlight-color: transparent; }
    html, body { min-height: 100%; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "PingFang SC", "Microsoft YaHei", sans-serif;
      background: #f5f6f7; color: #323233; font-size: 15px; line-height: 1.6;
    }
    .center-wrap { min-height: 100vh; display: flex; align-items: center; justify-content: center; padding: 24px; }
    .error-box { text-align: center; }
    .error-box svg { width: 56px; height: 56px; }
    .error-box .msg { margin-top: 12px; color: #969799; font-size: 14px; }
    .pw-card {
      background: #fff; border-radius: 12px; padding: 32px 24px; width: 100%; max-width: 360px;
      text-align: center; box-shadow: 0 2px 8px rgba(0,0,0,.06);
    }
    .pw-card svg { width: 40px; height: 40px; }
    .pw-card h3 { margin-top: 12px; font-size: 17px; font-weight: 600; }
    .pw-desc { margin-top: 6px; color: #969799; font-size: 13px; }
    #pw {
      margin-top: 20px; width: 100%; padding: 10px 0; text-align: center; font-size: 22px;
      letter-spacing: 10px; text-indent: 10px; border: none; border-bottom: 1px solid #ebedf0;
      outline: none; border-radius: 0; background: transparent; font-family: inherit;
    }
    #pw:focus { border-bottom-color: #1989fa; }
    .pw-error { margin-top: 10px; color: #ee0a24; font-size: 13px; min-height: 1px; }
    .pw-btn {
      margin-top: 20px; width: 100%; padding: 9px 0; border: none; border-radius: 20px;
      background: #1989fa; color: #fff; font-size: 15px;
    }
    .content-wrap { max-width: 560px; margin: 0 auto; padding: 16px 14px 32px; }
    .card { background: #fff; border-radius: 12px; padding: 16px; box-shadow: 0 2px 8px rgba(0,0,0,.06); }
    .header { display: flex; align-items: center; gap: 10px; }
    .avatar { width: 40px; height: 40px; border-radius: 50%; flex-shrink: 0; }
    .header-info { flex: 1; min-width: 0; }
    .author-name { font-size: 15px; font-weight: 600; }
    .time-text { margin-top: 2px; font-size: 12px; color: #c8c9cc; }
    .mood-tag {
      flex-shrink: 0; display: flex; align-items: center; gap: 3px; padding: 3px 10px;
      border-radius: 12px; background: #fff7e6; color: #fa9d3b; font-size: 12px;
    }
    .mood-tag svg { width: 13px; height: 13px; }
    .body-text { margin-top: 14px; word-break: break-word; overflow-wrap: anywhere; }
    .body-text img { max-width: 100%; height: auto; border-radius: 6px; }
    .body-text p { margin: 6px 0; }
    .body-text blockquote { margin: 8px 0; padding: 4px 12px; border-left: 3px solid #e5e6eb; color: #646566; }
    .body-text pre { margin: 8px 0; padding: 10px; background: #f7f8fa; border-radius: 6px; overflow-x: auto; font-size: 13px; }
    .body-text table { border-collapse: collapse; margin: 8px 0; max-width: 100%; }
    .body-text th, .body-text td { border: 1px solid #ebedf0; padding: 5px 10px; font-size: 14px; }
    .image-grid { margin-top: 12px; display: grid; grid-template-columns: repeat(3, 1fr); gap: 6px; }
    .image-grid.has-1 { grid-template-columns: 68%; }
    .image-grid img { width: 100%; aspect-ratio: 1; object-fit: cover; border-radius: 6px; display: block; background: #f7f8fa; }
    .location-row { margin-top: 12px; display: flex; align-items: center; gap: 4px; color: #969799; font-size: 13px; }
    .location-row svg { width: 14px; height: 14px; flex-shrink: 0; }
    .footer { margin-top: 14px; text-align: center; }
    .expire-hint { color: #c8c9cc; font-size: 12px; }
`;

const pageWrap = (title, body) => `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover">
  <meta name="robots" content="noindex, nofollow">
  <title>${escapeHtml(title)}</title>
  <style>${PAGE_STYLE}</style>
</head>
<body>
${body}
</body>
</html>`;

/** 错误页 */
const renderError = (message) =>
  pageWrap(
    "分享详情",
    `  <div class="center-wrap">
    <div class="error-box">
      <svg viewBox="0 0 48 48" fill="none"><circle cx="24" cy="24" r="22" stroke="#dcdee0" stroke-width="3"/><path d="M24 14v14" stroke="#dcdee0" stroke-width="4" stroke-linecap="round"/><circle cx="24" cy="34.5" r="2.5" fill="#dcdee0"/></svg>
      <p class="msg">${escapeHtml(message)}</p>
    </div>
  </div>`
  );

/** 密码模式页（原生表单，无 JS） */
const renderPasswordForm = (id, error) =>
  pageWrap(
    "分享详情",
    `  <div class="center-wrap">
    <div class="pw-card">
      ${LOCK_SVG}
      <h3>需要访问密码</h3>
      <p class="pw-desc">请输入分享者提供的 6 位数字密码</p>
      <form method="post" action="/share/diary/detail">
        <input type="hidden" name="id" value="${escapeHtml(id)}">
        <input id="pw" name="pw" type="password" inputmode="numeric" pattern="[0-9]*" maxlength="6" autocomplete="off" autofocus>
        <p class="pw-error">${escapeHtml(error || "")}</p>
        <button type="submit" class="pw-btn">验证</button>
      </form>
    </div>
  </div>`
  );

/** 内容页（data 来自 share 公开接口同构字段；expireAt 仅 token 模式有值） */
const renderContent = (data, expireAt) => {
  const mood = typeof data.mood === "string" && data.mood ? data.mood : "";
  const imgs = Array.isArray(data.img_url) ? data.img_url : [];
  const locName = data.location && data.location.name;
  const expire = expireText(expireAt);

  const imgHtml = imgs.length
    ? `      <div class="image-grid${imgs.length === 1 ? " has-1" : ""}">
${imgs
  .map((item) => {
    const url = resolveImg(item && item.url ? item.url : item);
    if (!url) return "";
    return `        <a href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer"><img src="${escapeHtml(url)}" alt="" loading="lazy"></a>`;
  })
  .filter(Boolean)
  .join("\n")}
      </div>`
    : "";

  return pageWrap(
    "分享详情",
    `  <div class="content-wrap">
    <div class="card">
      <div class="header">
        ${AVATAR_SVG}
        <div class="header-info">
          <div class="author-name">${escapeHtml((data.author && data.author.name) || "ta")}</div>
          <div class="time-text">${escapeHtml(formatTime(data.create_time))}</div>
        </div>
        ${
          mood
            ? `<div class="mood-tag"><svg viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="9" stroke="currentColor" stroke-width="2"/><path d="M8.5 14.5c.9 1.2 2.1 1.8 3.5 1.8s2.6-.6 3.5-1.8" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><circle cx="9" cy="9.5" r="1.2" fill="currentColor"/><circle cx="15" cy="9.5" r="1.2" fill="currentColor"/></svg><span>${escapeHtml(mood)}</span></div>`
            : ""
        }
      </div>
      <div class="body-text">${data.content || ""}</div>
${imgHtml}
      ${
        locName
          ? `      <div class="location-row"><svg viewBox="0 0 24 24" fill="none"><path d="M12 21s-7-5.5-7-11a7 7 0 0 1 14 0c0 5.5-7 11-7 11z" stroke="currentColor" stroke-width="2"/><circle cx="12" cy="10" r="2.5" stroke="currentColor" stroke-width="2"/></svg><span>${escapeHtml(locName)}</span></div>`
          : ""
      }
    </div>
    ${expire ? `    <div class="footer"><span class="expire-hint">${escapeHtml(expire)}</span></div>` : ""}
  </div>`
  );
};

/* ────────────── 数据组装（与 share JSON 接口同构） ────────────── */

const buildData = async (moment) => {
  let authorName = "ta";
  try {
    const user = await User.findById(moment.user_id);
    if (user) authorName = user.username || user.name || "ta";
  } catch {
    /* fallback */
  }
  return {
    id: moment.id,
    content: moment.content,
    img_url: safeJsonParse(moment.img_url),
    mood: safeJsonParse(moment.mood),
    location: safeJsonParse(moment.location),
    create_time: moment.create_time,
    author: { name: authorName },
  };
};

/* ────────────── 路由处理器 ────────────── */

/** GET /share/diary/detail */
const view = async (req, res) => {
  try {
    const token = req.query.token;
    const id = req.query.id;

    // ── token 模式 ──
    if (token) {
      let payload;
      try {
        payload = verifyShareToken(token);
      } catch (err) {
        console.error("[SharePage] Token verify error:", err.message);
        return html(res, 400, renderError("链接无效或已损坏"));
      }
      if (payload.exp < Date.now()) {
        return html(res, 410, renderError("分享链接已过期，请联系分享者重新获取"));
      }
      const moment = await Moment.findById(payload.did);
      if (!moment || moment.is_deleted) {
        return html(res, 404, renderError("内容不存在或已删除"));
      }
      let vis;
      try {
        vis =
          typeof moment.visible_type === "string"
            ? JSON.parse(moment.visible_type)
            : moment.visible_type;
      } catch {
        vis = null;
      }
      if (!vis || vis.vt !== 1) {
        return html(res, 403, renderError("分享已关闭"));
      }
      if (vis.vs !== payload.vs || String(vis.pw) !== String(payload.pw)) {
        return html(res, 403, renderError("链接已失效，请获取最新链接"));
      }
      const data = await buildData(moment);
      return html(res, 200, renderContent(data, new Date(payload.exp).toISOString()));
    }

    // ── 密码模式：渲染密码表单 ──
    if (id) {
      return html(res, 200, renderPasswordForm(id, ""));
    }

    return html(res, 400, renderError("链接无效"));
  } catch (error) {
    console.error("[SharePage] View error:", error);
    return html(res, 500, renderError("查看分享失败"));
  }
};

/** POST /share/diary/detail —— 密码表单提交（复用 verifyPassword 的防爆破与校验规则） */
const submit = async (req, res) => {
  try {
    // verifyPassword 内部只调用 res.json；用包装对象捕获结果，保证
    // 与 JSON 接口共用同一份内存防爆破 tracker 和完全一致的校验逻辑。
    let payload = null;
    await verifyPassword(req, { json: (j) => (payload = j) });

    if (payload && payload.status === 200) {
      return html(res, 200, renderContent(payload.data, null));
    }

    const message = payload ? payload.message : "验证失败";
    const id = (req.body && req.body.id) || "";
    return html(res, 200, renderPasswordForm(id, message));
  } catch (error) {
    console.error("[SharePage] Submit error:", error);
    return html(res, 500, renderError("验证失败"));
  }
};

module.exports = { view, submit };
