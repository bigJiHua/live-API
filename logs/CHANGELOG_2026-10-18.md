# 变更日志

> 补记 2026-10-11 ~ 2026-10-18 的跨端重要变更（上一份日志停在 2026-09-21）。
> 本文件按时间正序整理；10-17/10-18 的条目已随 `app-prod-release.apk`（2026-10-18 11:06）构建并验签。

---

## 2026-10-11（银行卡管理改离线 WebView）

> 范围：`APP/` + `web/src/webview/` + `web/vite.config.webview.js`
> 原原生实现 `CardManageScreen.kt` 未删除，备份在 `temp/备份/CardManageScreen-native-20261011/`；
> 回退方式：`AppRoot.kt` 的三条 CARD 路由改回 `CardManageScreen(nav, "debit"/"credit")`。

### 架构

| 文件 | 变更 |
|---|---|
| `APP/.../ui/bankcard/CardWebScreen.kt` | **新增**。页面壳：WebView 生命周期、取数、崩溃/加载遮罩；加载 `assets/card/webview.html` |
| `APP/.../ui/bankcard/CardWebView.kt` | **新增**。`AndroidCardBridge` 桥（ready/requestData/navigate/saveSort/onError）+ 数据/主题注入 |
| `web/src/webview/main.js` | **新增**。离线入口：不引 router/pinia/request/Lazyload；Vant 只注册 Icon/Empty/Overlay/Loading |
| `web/src/webview/CardOffline.vue` | **新增**。壳层 UI（借记/信用分段、预览、排序） |
| `web/src/webview/CardListPane.vue` | **新增**。列表 + CardStack + 排序（复用线上 `CardStack.vue`） |
| `web/src/webview/bridge.js` | **新增**。JS → 原生桥封装 |
| `web/vite.config.webview.js` | **新增**。`base:'./'`、`outDir:'dist-webview'`、IIFE、单文件产物 `card.js`/`card.css` |

### 三个「不改就白屏」的关键修复

| 问题 | 根因 | 修复 |
|---|---|---|
| 离线页 JS 完全不执行 | `file:///android_asset/` 的 origin 是 `null`，ES module 走 CORS 被拒 | 产物改 `format:'iife'`，并把 `<script type="module">` 替换为 `<script defer>` |
| 整屏只剩「+添加卡片」 | WebView 在首次 layout 前 `loadUrl` ⇒ 0 高视口，`height:100%` 链整条解析成 0 且不再重解析 | 根容器 `position:fixed;inset:0`；`loadUrl` 推迟到 `doOnLayout` 且高度 > 0 |
| 数据注入成功但页面空态 | 原生 `org.json` 直接 `put(List<JSONObject>)` 在 JS 侧不是数组 | `buildCardPayload` 显式包 `JSONArray`；注入回执三态（ok/no-bridge/err） |

---

## 2026-10-12（登录 401 风暴 + 卡片页收尾）

### 1. 登录 401 风暴（P0-5 httpOnly Cookie 改造的 4 个连锁冲突）

| 冲突 | 修复 |
|---|---|
| `pinSecurityGuard` 只认 Bearer、不读 Cookie ⇒ web 用户 PIN 风控静默失效 | `authGuard.js` 导出 `extractToken`，`pinSecurityGuard` 复用（口径单一来源） |
| 路由守卫/`restoreSession` 用主 request 实例探 `/auth/me`，未登录 401 被拦截器当成「登录失效」→ 与路由软导航竞争，整页反复刷新 | `authState` 新增 `probeMe()`：原生 fetch 静默探测，绕开拦截器；`ensureSession` 默认用它 |
| `forceLogin` 无防循环 | 已在 `/login` 静默返回；加 10s 冷却（localStorage，避免被 `sessionStorage.clear()` 清掉） |
| `router/index.js`「已登录访问 /login 踢回首页」是死代码 | 移到白名单放行之前 |

回归：`api` jest 225/229（4 项为预存在失败）；`web` build ✓；smoke 53+36+89+59 全绿。
衍生：API_Go `mw.AuthGuard` / `pin.go extractBearerUID` 同样只认 Bearer → 登记 SYNC-013。

### 2. 卡片离线页修复

| 文件 | 变更 |
|---|---|
| `web/src/webview/CardListPane.vue` | 补传 `:scrolled` —— 原漏传导致「顶栏收起、添加按钮不隐藏」 |
| `web/vite.config.webview.js` | 明确**不能**加 `__VUE_OPTIONS_API__:'false'`：会把选项 API 整体树摇掉，`vuedraggable` 的 computed/mounted 全丢 ⇒ 排序列表 0 项、拖不动 |
| `APP/.../CardWebView.kt` | 主题注入不能用 `Color.value` 按位取色（Compose 的 ARGB 在高 32 位）⇒ 改 `red/green/blue/alpha` 浮点分量 |
| `APP/.../CardWebScreen.kt` | 回退 `LOAD_NO_CACHE`（会连主文档带子资源被拦），改 `clearCache(true)` + `LOAD_DEFAULT` |

---

## 2026-10-12 ~ 10-13（API_Go 八阶段同步收尾）

> 范围：`API_Go/`；**Node `api/` 全程零改动**（5239 个 .js 基线比对通过）。
> 交付物：根目录 `API_Go 同步现状与待改进清单.md`、`API_Go版本同步对齐报告-2026-10-12.md`。

- 24 个模块逐行核对 + 4 条端到端链路走查；`go build/vet/gofmt` 全 0；**196 项测试 / 16 包全过**。
- 关键修复：NanoID 越界 panic、Go 端补 Set-Cookie 通道、pin 与 appSignature 中间件装反、`/api/v1/**` 404 返回 text/plain、单表 mysqldump 误用 `--databases`、配置项在 `config.Load()` 前求值导致 `.env` 不生效、card 校验层（`null`/空串/`sort` 默认 99）、`fund.historyProfitExpr` 漏减本金、`recurring` 宽限期未按日归一。
- 三条「自创加固」被回退（验证码 scene、导入 10MB 上限、`v == nil` 跳过更新）——没有 Node 基准背书的加固就是行为变更。

---

## 2026-10-14（站点分发适配）

- APP 支持用户在登录页填写 API 站点地址，持久化到 `SiteStore`（`finance_site`），不再依赖构建期 `BASE_URL`。
- **该版本已于 2026-10-17 被 BYO-backend 定稿覆盖**（见下条）。

---

## 2026-10-17（APP BYO-backend 定稿）

> 决策：一份签名 APK 适配所有部署；站点地址只在运行时由用户输入。

| 不变量 | 落地 |
|---|---|
| `BuildConfig` 无 `BASE_URL` / `SITE_URL` | `APP/app/build.gradle.kts` 删除对应 `buildConfigField`；`AppConfig.baseUrl/siteUrl` 初始空串 |
| 未接入站点禁止登录 | `AppConfig.hasSite` + `ApiClient` 出口守卫（避免空 baseUrl 抛 `IllegalArgumentException`） |
| 保存站点前必须探测 | `SiteProbe.kt` → `GET {base}/api/health`，要求 `data.service == "live-finance"`；失败不落盘 |
| 旧后端不兼容 | `/api/health` 是新增端点，旧站 404 ⇒ 提示「站点版本过低」 |
| 分享 URL | 登录后「我的 → 设置」填写；未填时分享入口阻断 |

Node（`api/app.js`）、Go（`API_Go/internal/srv/server.go`）、APP（`core/net/SiteProbe.kt`）三处 `service` 标识必须一致。

---

## 2026-10-18（APP WebView 稳定性 / 日记编辑器 10 行 / 底部玻璃岛 / 签名文档）

> 范围：`APP/` + `web/src/webview/` + `APP/app/src/main/assets/editor/` + 签名文档
> 验证：`npm run build:webview` ✓；`:app:compileProdDebugKotlin` ✓；`:app:assembleProdRelease` ✓（apksigner 验签，指纹与 `build-strp/fingerprint.txt` 一致）

### 1. 银行卡管理页（离线 WebView）

| 文件 | 变更 |
|---|---|
| `web/src/webview/CardListPane.vue` | ① 移除 `van-overlay`（默认 `rgba(0,0,0,.7)` 深色底，加载时整页突然变暗），改透明 `.pane-loading`；② 新增下拉刷新手势 + 顶部指示器（阈值 56px、0.55 阻尼、8s 兜底）；③ 非 scoped 覆盖 `CardStack`：去掉 `.stack-backdrop` 的 `backdrop-filter`、`.is-dimmed` 的 `blur(1px)`、锁死 `html/body overflow` |
| `web/src/webview/CardOffline.vue` | `setTab()` 不再顺手关 `loading` —— 原逻辑把「取数未回」伪装成「加载完成但没数据」 |
| `web/src/webview/bridge.js` | 新增 `native.refresh(tab)`（与 `requestData` 分开，兼容旧页面） |
| `APP/.../CardWebView.kt` | 桥新增 `@JavascriptInterface refresh(tab)`；`buildCardWebView` 增加 `onRefresh` 参数 |
| `APP/.../CardWebScreen.kt` | ① 取数节流 `CardWebThrottle` 从**进程级 object** 改为 `remember(reloadKey)` 的页面实例级（修复「编辑/删除返回后首屏 fetch 被旧 10s 窗口挡掉 ⇒ 列表空」）；② `fetch(tab, force)` 支持下拉强制刷新；③ force 刷新不打开居中 loading（用页面自己的指示器） |

**根因记录**
- 弹卡瞬间背景闪一下：`backdrop-filter: blur(10px)` 首次出现要为整片下层创建离屏纹理，叠加每张未选中卡的 `blur(1px)`；`document.body.style.overflow` 切换又触发一次整页重排。
- 返回列表变空：`CardWebThrottle` 是进程级单例，跨页面实例保留；新 WebView 的首屏取数被跳过，同时 `setTab` 已把 loading 关掉。
- 加载变暗：`van-overlay` 自带 70% 黑底，且无过渡。

### 2. 日记「精准模式」编辑器

| 文件 | 变更 |
|---|---|
| `APP/.../assets/editor/index.html` | 书写区固定 **288px**（10 行 × 16px × 1.6 = 256px 内容 + 上下 padding 32px）；`#editor` 不再依赖 `height:100%`/视口；补 `.w-e-scroll { overflow-y:auto }`；新增 `fitEditor()` 实测「工具条 + 书写区」总高并回调 `onEditorHeight` |
| `APP/.../DiaryRichEditorWebView.kt` | ① `loadUrl` 前 `clearCache(true)`（assets 页面同样会被 WebView 缓存，只装新 APK 可能仍跑旧页）；② 新增桥方法 `onEditorHeight(px)` 与 `RichEditorState.editorHeightPx`；③ WebView 高度按回报值设置，**CSS px 直接当 dp 用**（禁止再走 `px.toDp()`，2.75 密度下会把 380 缩成 138dp ⇒ 高度塌陷） |
| `APP/.../DiaryAddScreen.kt` | ① 移除 `weight(1f)`，高度由编辑器按 10 行决定；② 本页临时 `SOFT_INPUT_ADJUST_NOTHING`（键盘不再把「今日心情/添加图片/当前位置」顶上去），`decorView.post` 补设一次，离开恢复原值；新增 `Context.findActivity()` |

### 3. 主壳底部玻璃岛 TabBar

| 文件 | 变更 |
|---|---|
| `APP/.../ui/main/MainScreen.kt` | `FloatingIslandBar` 底色 alpha 由 0.62/0.55 提到 **0.88**，叠加顶部白色高光渐变（0.16 → 0.04 → 透明），保留 1px 描边 + 投影 |

说明：Compose 无 `backdrop-filter` 等价物，`Modifier.blur` 只模糊自身、haze 需引依赖（与离线编译冲突），故用「高不透明度 + 高光 + 描边」做磨砂质感。

### 4. 签名与文档审计

- 确认签名链路完整：`APP/release.jks`（alias `live`）→ `build-strp/release.local.bat` → `2-build-signed-apk.bat` → `fingerprint.txt` → `api/.env` 的 `APP_SIGN_SHA256`（`APP_SIGN_ENFORCE=loose`）。
- 修正 4 处过期信息：
  1. `docs/docs/app/release-signing.md`：签名入口改为 `build-strp\2-build-signed-apk.bat`；明确 `APP/gradle.properties` 的 `RELEASE_*` 特意留空（直接 gradle 出 `-unsigned.apk`）。
  2. 同文档附录：删除 `API_BASE_URL` / `SITE_URL` 必填（BYO-backend 后已移除）。
  3. `APP-RELEASE-SIGNING.md`：构建步骤/速查补脚本方式。
  4. `APP/app/build.gradle.kts` 顶部注释 + `docs/docs/guide/env-config.md`：删除「上线必填 API_BASE_URL / BuildConfig.BASE_URL」。

---

## 遗留 / 待验证

- 卡片下拉刷新与透明 loading：需真机确认「刷新中」指示器与列表数据同步。
- 日记 10 行书写区：需真机确认工具条换行数（Logcat `RichEditor` 的 `[fit] bar=… editor=288 total=…`）。
- 底部玻璃岛：真机确认深浅色下的磨砂观感。
- 卡片返回列表的根因已在代码层修复（页面实例级节流），仍需在「编辑保存/删除后返回」路径上回归一次。
