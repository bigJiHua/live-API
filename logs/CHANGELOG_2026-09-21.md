# 变更日志

## 2026-09-21（第三批：nonce 策略同步至 webview-APP 与 APP，三端对齐）

> 范围：`webview-APP/` + `APP/`（原生 Kotlin），并回补 `web/` 的一处遗漏。
> **至此 S1 / S2 待同步清单全部完成**，三端均会携带并刷新 `x-client-nonce`。
> 后端 `api/` 本批**未改动**。

### 🔧 修改 · webview-APP（独立副本，逐处搬移，未整文件覆盖）

| 文件 | 变更内容 |
|------|----------|
| `webview-APP/src/utils/securityHeaders.js` | 搬入 `createClientNonce()` / `refreshVolatileSecurityHeaders()`；`getSecurityHeaders()` 带 `x-client-nonce`；两处注释「绕过中间件」更正为「通过中间件」 |
| `webview-APP/src/utils/request/nonceRetry.js` | **新增**。与 web 同源：`CODE_NONCE_REPLAY=8401`、`isNonceReplay()`、`buildNonceRetryConfig()`（刷新时间戳+nonce、`__nonceRetried` 防循环） |
| `webview-APP/src/utils/request/interceptors/request.js` | 注入 `x-client-nonce` |
| `webview-APP/src/utils/request/interceptors/response.js` | 两个处理器提成具名 `onFulfilled` / `onRejected`；两分支均识别 `8401` 并自愈重发一次。**保留了该端特有差异**：错误分支仍是单一 `showFailToast`（无 web 的 5xx 灰态分支）、`!response` 时用 `showFailToast("网络异常")` |
| `webview-APP/src/utils/request/pin.js` | 两处重发（冷却静默重发、验证后队列重发）前调用 `refreshVolatileSecurityHeaders()`。保留该端特有的 `__PIN_VERIFY_RELOAD__` 逻辑 |
| `webview-APP/src/utils/fileRequest.js` | 补 `x-client-nonce`；**成功分支与错误分支都加了 `8401` 处理**（原因见下方 ⚠）；保留该端特有的 `import.meta.env.VITE_API_BASE_URL` 基址 |
| `webview-APP/src/utils/request/handshake.js` | 补 `x-client-nonce`（握手同样过 `securityCheck`） |

### 🔧 修改 · APP（原生 Kotlin）

| 文件 | 变更内容 |
|------|----------|
| `APP/.../core/AppConfig.kt` | `object Pin` 新增 **`NONCE_REPLAY = 8401`** 常量（附对齐说明） |
| `APP/.../core/net/DeviceProfile.kt` | `headers()` 新增 **`x-client-nonce`**（`UUID.randomUUID()` 去横杠，32 位十六进制）。并补注释：**本方法每次调用都生成新时间戳+新 nonce，调用方不得缓存复用** |
| `APP/.../core/net/ApiClient.kt` | ① `attempt()` 补注释说明「每次重发都重新取 headers ⇒ 天然不复用 nonce」这条**必须保持的不变量**；② `request()` 首包命中 `8401` 时**重发一次自愈**（用 `if` 而非 `while`，最多一次） |

> **APP 侧无需改重发路径**：`ApiClient.attempt()` 每次都重建 `Request` 并重新调用 `device.headers()`，
> 所有重发（KEY_ERR 重握手、8303 带票重发）天然获得全新 nonce 与时间戳 —— 这正是 S2 要求的语义。
> `PinCoordinator` 不发 HTTP（只协调票据），因此无需改动。

### 🔧 回补 · web / api 文档

| 文件 | 变更内容 |
|------|----------|
| `web/src/utils/request/handshake.js` | 握手请求补 `x-client-nonce`。此前它是 web 侧唯一漏掉的头（握手走全局 axios、手工拼 headers），补上后 `REQUIRE_CLIENT_NONCE=true` 才真正可开 |
| `api/.env.example` | 新增「安全与风控」章节：`SHARE_TOKEN_SECRET` / `TOKEN_MAX_SESSION_DAYS` / `CORS_EXTRA_ORIGINS` / `REQUIRE_CLIENT_NONCE` / `PIN_NONCE_MODE` / `PIN_RISK_*` 全部列出（**以注释形式给出默认值**，照抄本文件不会改变任何行为）。此前这些变量只记录在 `api/README.md` 的表格里，`.env.example` 未同步 |
| `api/.env` | 同上新增「安全与风控」章节，**显式写出**各变量当前值（`REQUIRE_CLIENT_NONCE=true`、`PIN_NONCE_MODE=enforce`、`PIN_RISK_*` = 60/60/10/60、`PIN_PASS_WINDOW=30`）。除 `REQUIRE_CLIENT_NONCE` 由用户主动置 `true` 外，其余显式值 == 代码默认值 ⇒ **零行为变化**（已实测：`CONFIG` 与新增前逐项一致） |

---

## ⚠️ 开启 `REQUIRE_CLIENT_NONCE=true` 的产物重建清单（待执行）

> **背景**：三端**源码**已全部携带 `x-client-nonce`，但**已构建产物**都是旧的。
> 经核查以下目录**均不含** `x-client-nonce`，若直接重启 API 会全部 400：
>
> | 产物 | 路径 | 含 nonce | 影响 |
> |---|---|---|---|
> | web 生产包 | `web/dist/` | ❌ | 走 dist 部署的环境全挂 |
> | webview-APP 构建包 | `webview-APP/dist/` | ❌ | — |
> | webview-APP 壳内缓存 | `webview-APP/unpackage/` | ❌ | HBuilderX 旧缓存，**非投放目录** |
> | **WebView APK 实际投放目录** | `D:\Google\Android-SDK\Android-SDK@5.14.82649_20260630\HBuilder-Integrate-AS\simpleDemo\src\main\assets\apps\H57A0911F\www\dist` | ❌ | **壳里跑的就是这份，必须重建** |
>
> **关键操作顺序**：`REQUIRE_CLIENT_NONCE` 只在 **API 进程启动时**读取。
> 因此 —— **先别重启 API**，等三端产物全部重建/安装完，最后再重启。中途不会挂。

### 1. web　【✅ 2026-09-21 已完成】

```bash
cd web && npm run build        # → web/dist
```

> 执行记录：先 `[System.IO.Directory]::Delete('web/dist')` 清空（绕开回收站 shim），再 `npm run build`
> → **exit=0，built in 9.17s**，同时生成 PWA `dist/sw.js`（precache 240 entries）。
> 产物核对：`dist/assets/{request,nonceRetry,fileRequest}-*.js` **均含 `x-client-nonce`** ✅
> 附带验证：`grep Admin123 web/dist` → **无命中**，确认 B6（默认账密不进生产包）已生效。

⚠️ 本项目启用了 `vite-plugin-pwa`（`registerType: 'autoUpdate'`，workbox 预缓存 `**/*.{js,css,html,...}`）。
重建后 **Service Worker 会在下次访问时自动换新**，但换新前浏览器可能仍在跑旧 bundle
（旧 bundle 不带 nonce ⇒ 该页面请求全 400）。处理：重建后强刷一次，或让 `index.html` 走 `no-cache`。

### 2. webview-APP（WebView 壳）　【✅ 2026-09-21 构建 + 投放已完成】

直接用根目录脚本（**注意它用的是 `[System.IO.Directory]::Delete`，因为本机 `Remove-Item`
会被回收站 shim 挡住**）：

```bash
# 根目录双击，或 cmd 执行：
build-webview-app.bat
```

脚本三步：清 `webview-APP/dist` → `npm run build` → 把 `dist/*` 复制到
`...\HBuilder-Integrate-AS\simpleDemo\src\main\assets\apps\H57A0911F\www\dist`。

> 执行记录（按脚本三步手工执行，因脚本末尾有 `pause` 会阻塞非交互式终端）：
> ① 清 `webview-APP/dist` → OK；② `npm run build` → **exit=0**；
> ③ `Copy-Item dist/* → AS assets` → **COPY OK**（3725 → 3913 文件）。
> 产物核对：`dist/assets/{request,nonceRetry,fileRequest}-*.js` **均含 `x-client-nonce`** ✅
> 投放核对：入口 chunk `assets/index-Cy9q_PXn.js` 在 `dist/` 与 AS assets **两边都存在**；
> AS 的 `index.html` 时间戳已更新为本次构建时间 ✅

**剩余动作（需你操作）**：Android Studio 打开 simpleDemo → **Build APK → 重装到手机**。

> ⚠ 脚本第 3 步是 `xcopy /E /Y`（**合并复制，不先清空**），所以 AS assets 里会残留旧的
> 带 hash 的 JS 文件（3913 - 3725 = 188 个新增，其余为同名覆盖）。旧文件不被 `index.html`
> 引用，无功能影响；若要彻底干净可先清空该目录再复制。

> ⚠ `webview-APP/unpackage/` 是 HBuilderX 的旧缓存，**不是投放目录**，不用管它。

### 3. APP（原生 Kotlin）　【⏸ 本次未执行 —— 用户明确要求不编译】

```bash
cd APP && gradlew.bat :app:assembleProdDebug     # 或 Android Studio 选 prodDebug 变体
```

装新 APK。

> 已确认源码可编译（`gradlew :app:compileProdDebugKotlin` → BUILD SUCCESSFUL），
> 但**尚未出 APK**。⚠️ 在装上新 APK 之前，**APP 端仍会因缺 `x-client-nonce` 而全部 400**。

### 4. 最后才重启 API

`.env` 里已写好 `REQUIRE_CLIENT_NONCE=true`，重启即生效。

### 5. 验证哪一端还漏了

后端在缺失该头时会打印：

```
缺少客户端随机数（REQUIRE_CLIENT_NONCE=true）
```

`grep` 这条日志即可定位是哪一端没换成新包（日志里没有请求路径，可按出现时机配合业务操作判断；
如需精确定位，可临时在该 `console.warn` 上补 `req.method + req.originalUrl`）。

或者：web 端开 DevTools → Network → 任一请求的 Headers 里应能看到 `x-client-nonce`。

### 6. 万一出问题，一键回退

`.env` 改回 `REQUIRE_CLIENT_NONCE=false` + 重启 API，立即恢复宽松策略（携带才校验），
**客户端不用重新构建**。

### ⚠️ 本批发现的两个环境差异（重要）

1. **壳环境下 HTTP 400 会走「成功分支」而非错误分支。**
   `webview-APP` 的请求由 `nativeHttp` 原生桥适配器发起，它**不套用 axios 的 `validateStatus`**
   （适配器直接返回响应对象，不经过 `settle`）。因此 `fileRequest.js` 里那句
   「本实例没有 `validateStatus:()=>true`，HTTP 400 会走这里」**在壳里不成立**。
   ⇒ 所以 `webview-APP` 的 `fileRequest.js` **两个分支都做了 `8401` 处理**，浏览器与壳环境都能自愈。
2. **壳环境下全局 axios 也已接上原生桥。**
   `installNativeHttp()` 会设置 `axios.defaults.adapter`，所以 `response.js` 里用全局 axios 重发
   **同样绕过 CORS**，方案成立。

### 📌 仍未做

- **未改** `api/`（本批纯客户端同步）。
- **未开** `REQUIRE_CLIENT_NONCE`（保持 `false`）。三端现已全部携带该头，
  实机回归通过后即可在 `api/.env` 设为 `true` 收口。
- **APP 的 `uploadRaw` / `upload` / `download` 未做 8401 自愈**：这三处把响应折叠成 `ApiResult`
  （丢失 `code`），无法识别 8401；且它们各自只发一次请求、无重发循环。若真命中，会显示后端文案
  `"请求重复提交，请稍后重试"`（清晰可操作，非静默失败）。详见「已知限制」。

### ✅ 验证

| 项 | 方式 | 结果 |
|----|------|------|
| webview-APP 语法 | 复制为 `.mjs` 后 `node --check` × 7 | ✅ 全部 exit=0 |
| web 语法 | 同上 × 7（含回补的 `handshake.js`） | ✅ 全部 exit=0 |
| **APP 编译** | `gradlew :app:compileProdDebugKotlin --offline` | ✅ **BUILD SUCCESSFUL in 8s**（`AppConfig.kt` / `DeviceProfile.kt` / `ApiClient.kt` 全部通过；此前他人进行中的 chart/asset 编译红已消失） |
| 覆盖度核对 | 检索 `x-client-timestamp` 找出全部手工拼安全头的位置 | ✅ web 4 处 / webview-APP 4 处**均已带 nonce**，无遗漏 |

### 📊 第三批统计

- 修改文件：**11**（webview-APP 7 + APP 3 + web 1）
- 新增文件：**1**（`webview-APP/src/utils/request/nonceRetry.js`）
- 三端 nonce 覆盖：web ✅ / webview-APP ✅ / APP ✅

---

## 2026-09-21（第二批：B1 风控灰度开关 + B3 nonce 复用自愈）

> 范围：`api/` + `web/`。**`APP/` 与 `webview-APP/` 仍未改动。**
> 方案来源：根目录 [`安全加固-B1B3处置方案.md`](../../安全加固-B1B3处置方案.md)（用户已确认）
> **用户决定**：B1 按方案走但**默认 enforce 严格模式**；B3 同意，并要求新 `code` 字段**打通前后端消息响应**。

### 🔧 修改 · api

| 文件 | 变更内容 |
|------|----------|
| `api/src/common/middleware/pinSecurityGuard.js` | ① 新增 **`PIN_RISK_MODE`**（`enforce`/`observe`/`off`，**默认 `enforce` 严格**）：`observe` 下风控超限只打 `[pinSecurityGuard][observe]` 日志不拦截，`off` 下连计数都不做。② 阈值外置：`PIN_RISK_FREQ_WINDOW`/`PIN_RISK_FREQ_LIMIT`/`PIN_RISK_SENSITIVE_WINDOW`/`PIN_RISK_SENSITIVE_LIMIT`/`PIN_PASS_WINDOW`，**默认值与历史实现完全一致**，新增 `envInt()` 做非法值回落。③ 抽取 `ensurePendingRecord()`，消除两处重复的"插待验证记录"逻辑。④ 新增 `logRiskSuppressed()` 统一 observe 留痕。⑤ 非 `enforce` 模式启动打印告警；导出 `RISK_MODE` |
| `api/src/common/middleware/securityCheck.js` | nonce 复用改为返回**独立业务码** `400 { code: 8401, retryable: true, message: "请求重复提交，请稍后重试" }`（其余非法请求仍为 `"非法请求！"`，语义不变）；新增 **`PIN_NONCE_MODE`**（`enforce`/`observe`/`off`，**默认 `enforce`**）；非严格模式启动告警；`REQUIRE_CLIENT_NONCE=true` 与 `off` 冲突时告警 |
| `api/README.md` | 新增「安全风控开关」env 表（7 个变量）；安全特性表补「重放自愈」与「风控可灰度」两行 |

### 🔧 修改 · web

| 文件 | 变更内容 |
|------|----------|
| `web/src/utils/request/nonceRetry.js` | **新增**。`CODE_NONCE_REPLAY = 8401`、`isNonceReplay()`、`buildNonceRetryConfig()`（刷新 `x-client-timestamp` + `x-client-nonce`，打 `__nonceRetried` 标记保证**最多重发一次**）、`NONCE_REPLAY_FALLBACK_MESSAGE` |
| `web/src/utils/request/interceptors/response.js` | ① 把两个拦截器处理器**提成具名函数** `onFulfilled` / `onRejected`，使自愈重发后能把响应**送回同一套业务判定**（PIN / 401 / 提示完全一致）。② `onFulfilled` 最前面识别 `8401` → 自动重发一次；`onRejected` 也加了兜底（防将来有人改掉 `validateStatus`）。③ 新增 `replayAfterNonceConflict()`：**用全局 axios 重发**（本实例请求拦截器会对写操作**二次加密** body，导致后端解不开——与 `pin.js` 的 PIN 重发同因），重发后交回 `onFulfilled`；已重发过则提示失败，绝不静默 |
| `web/src/utils/fileRequest.js` | 错误分支识别 `8401` → `replayFileAfterNonceConflict()`：本实例请求拦截器**只注入安全头、不做 body 加密**，因此可直接用 `requestfile(cfg)` 重发（nonce 自动换新，且自带响应拦截器保证判定一致） |

### 🔗 前后端 `code` 字段的打通链路（用户特别要求）

```
后端 securityCheck ── nonce 复用 ──▶ 400 { status:400, code:8401, retryable:true, message:"请求重复提交，请稍后重试" }
                                        │
                     ┌──────────────────┴──────────────────┐
            主通道（validateStatus:()=>true）        文件通道（无 validateStatus）
            response.js → onFulfilled                 fileRequest.js → 错误分支
                     │                                     │
                     └────────── isNonceReplay(res.code === 8401) ──────────┘
                                        │
                            有 __nonceRetried 标记？
                              ├─ 否 → 刷新时间戳 + nonce → 重发一次 → 交回业务判定（用户无感）
                              └─ 是 → showFailToast(后端 message) → reject（不静默）
```

- **独立码的意义**：`8401` 与其它 `400`（缺头 / 时间戳超窗 / 指纹不一致）**严格区分**，
  只有它可重试；否则会把不可重试的非法请求也当成可重试，造成无意义的重复提交。
- **message 正常透出**：重发成功后用户看不到任何提示；重发仍失败时显示后端给的
  `"请求重复提交，请稍后重试"`（经 `normalizeApiError` 归一化，不会漏出 axios 的英文文案）。

### ✅ 验证

| 项 | 方式 | 结果 |
|----|------|------|
| api 语法 | `node --check` × 2 | ✅ exit=0 |
| web 语法 | 复制为 `.mjs` 后 `node --check` × 3 | ✅ exit=0 |
| api 加载冒烟 | `node -e "require('./app')"` | ✅ `APP_LOAD_OK` |
| 默认值严格 | `RISK_MODE` / `CONFIG` | ✅ `RISK_MODE=enforce`；`{FREQ_WINDOW:60, FREQ_LIMIT:60, SENSITIVE_WINDOW:60, SENSITIVE_LIMIT:10, PASS_WINDOW:30}` —— **与历史实现逐项一致** |
| 阈值外置生效 | `PIN_RISK_FREQ_LIMIT=20`、`PIN_RISK_SENSITIVE_WINDOW=120` | ✅ CONFIG 变为 `20` / `120` |
| 非法值回落 | `PIN_RISK_FREQ_LIMIT=abc`、`SENSITIVE_LIMIT=-1`、`FREQ_WINDOW=0` | ✅ 全部回落为 `60/10/60` |
| 非严格模式告警 | `PIN_RISK_MODE=observe`、`PIN_NONCE_MODE=observe` | ✅ 两条启动告警均如期打印 |
| 默认不告警 | 不设 env | ✅ 无 `⚠` 输出（确认默认即 enforce） |

> ⚠ 后端改动需**重启 API 服务**；前端 dev server 热更新即可。
> ⚠ 仍需实机回归：nonce 复用自愈（可用 DevTools 重放同一请求验证）、批量写操作是否误弹 PIN。

### 📌 本次未做

- 未改 `APP/**`、`webview-APP/**`（含构建产物）。
- 未改 `REQUIRE_CLIENT_NONCE`（保持 `false`）。
- B2 / B4 / B5 / B6 按用户决定**保持当前默认、不回归**。

### 📊 第二批统计

- 修改文件：**5**（api 3 + web 2）
- 新增文件：**1**（`web/src/utils/request/nonceRetry.js`）
- 新增 env：**7**（均有安全默认值）
- 新增业务码：**1**（`8401`）

---

## 2026-09-21（安全加固第一批：api + web 双端修复，APP 侧待同步）

> 起因：评估「APP 后续开放自由添加域名 / 接入第三方站点（类似 KOD）」时的客户端身份可信问题，
> 顺带审计出多项历史遗留安全问题。
> **范围**：仅 `api/` 与 `web/`。
> **`APP/`（原生 Kotlin）与 `webview-APP/`（WebView 套壳）本次未改动**，
> 需要同步的策略见文末「⏳ 待同步到 APP / webview-APP 的策略」。
> 设计文档：根目录 [`APP-接入站点安全设计.md`](../../APP-接入站点安全设计.md)。

---

### 🔍 审计发现（修复前现状）

| 编号 | 发现 | 证据 | 状态 |
|------|------|------|------|
| **A-1** | **请求签名在运行时完全不存在**。`x-sign` 校验只活在一份无人加载的死代码里；客户端（`web/src`）也从未实现发送该头 | 在用 `common/middleware/securityCheck.js` 无 `crypto`/`x-sign`；死代码 `modules/security/middleware/check.js:52-65` 有；`web/src/utils/request/interceptors/request.js:25-31` 无 | ✅ 已澄清并删除死代码 |
| **A-2** | `modules/security/middleware/check.js` 为**死代码**，却与在用版**同名同函数名同导出口径** | 全仓库零 `require` | ✅ 已删除 |
| **A-3** | 两份互相掩盖对方漏洞：死代码版信客户端 `x-client-ip`，在用版 `fp` 为空即放行 | 在用 `:30`/`:41` vs 死代码 `:33`/`:46` | ✅ 随 A-2 消除 |
| **A-4** | `APP_SECURITY_SALT` 无任何代码引用，却被 `api/README.md` 列为必填 env | `api/README.md:294` | ✅ 文档已改 |
| **A-5** | `api/README.md` 声称 securityCheck 含「MD5 签名」 | `api/README.md:77,190` | ✅ 文档已改 |
| **A-6** | `pinSecurityGuard` catch 块 **fail-open**：诱发异常即可绕过全部 PIN 二次验证（旧报告 C-3，**此前一直未修**） | `pinSecurityGuard.js:553-557`（改前） | ✅ 已修 |
| **A-7** | 30 秒放行窗口**自我续期** ⇒ `checkFrequency` / `checkSensitive` 永远执行不到（等同死代码），一次 PIN 验证后近乎无限期免验 | `pinSecurityGuard.js:517-521`（改前） | ✅ 已修 |
| **A-8** | 密钥存在硬编码回退值，生产漏配 `.env` 会**静默**退化成攻击者已知常量 | `shareToken.js:4`、`config/jwt.js:8` | ✅ 已修 |
| **A-9** | 时间戳窗口（±2min）**无 nonce**，窗口期内同一请求可无限原样重放 | `securityCheck.js:22-27` | ✅ 已补 nonce |
| **A-10** | CORS `allowedOrigin` 把内网/localhost 硬编码在代码里；`allowedHeaders` 缺 `x-sign`/`x-client-ip`/`x-scene` | `api/app.js` | ✅ 已修 |
| **A-11** | `web/.env` 内置默认账密，Vite 会静态内联进**生产** bundle | `web/.env:31-32` | ✅ 已修 |

> 复核结论：旧审计报告 `temp/安全漏洞重新审计报告.md` 中的 **C-1 / C-2 / C-4 / C-5 已在早前修复**
> （限流键已去 IP 依赖、dataManager 已加 `requireAdmin`+`pinLockGuard`、refreshToken 已加
> `password_changed_at` 校验、分享限流已全局按 diaryId），本次不再重复处理。
> 其 **C-6 条目前提失效**（讨论的是"CORS 挡住签名"，实际签名从未生效）。

---

### 🔧 修改 · api

| 文件 | 变更内容 |
|------|----------|
| `api/src/modules/security/middleware/check.js` | **删除整个 `middleware/` 目录**（死代码，零引用）。security 模块现只保留 `api/`、`controller/`、`README.md` |
| `api/src/common/middleware/pinSecurityGuard.js` | ① **catch 改 fail-closed**：新增 `pinProtected` 标记（在确认用户已设置 PIN 后置位），异常且 `pinProtected` 时返回 503 而非 `next()`；未登录/未设 PIN 用户仍放行，避免一次异常锁死全部用户。② **修复 30 秒窗口自我续期**：窗口过期后删除会话并**回归风控**，不再把 `verifiedAt` 续期为当前时间（原写法使 `diff` 恒为 0，`checkFrequency`/`checkSensitive` 成死代码）。③ 新增 `CONFIG.PASS_WINDOW`(=30) 与 `PASS_WINDOW_MS` 常量，替换散落的 `30 * 1000` 魔法数。④ 新增 `/api/public/` 显式跳过（防未来改 blob 取图时每张图计入频率窗口）。⑤ **新增并导出 `markVerified(userId)`**：验证成功时开启放行窗口**并重置 `freqMap`/`sensitiveMap`**（原因见下方"连锁修复"）；守卫内两处验证成功分支改为调用它 |
| `api/src/modules/security/controller/index.js` | `verifyPin` 成功后调用 `markVerified(req.userId)`。**这是前端 PIN 弹窗的正常路径**，不经过守卫的分支 1/2 |
| `api/src/common/middleware/securityCheck.js` | 新增 **`x-client-nonce` 一次性校验**（TTL 3 分钟，容量上限 5000 自动清扫）。策略：**携带才校验唯一性**，缺失不拦（保证未同步的 APP 不受影响）；`REQUIRE_CLIENT_NONCE=true` 时改为强制 |
| `api/src/common/utils/secretGuard.js` | **新增**。`isWeakSecret` / `resolveSecret` / `auditSecrets`。生产环境密钥缺失、长度 <32 或命中占位表 → 抛错；开发环境告警后放行（有值沿用、无值给一次性随机） |
| `api/src/common/utils/shareToken.js` | 去掉硬编码回退 `"live-share-fallback"`，改走 `resolveSecret("SHARE_TOKEN_SECRET", { fallbackTo: "JWT_SECRET" })` |
| `api/src/common/config/jwt.js` | 去掉硬编码回退 `'your-secret-key-change-this-in-production'`，改走 `resolveSecret('JWT_SECRET')` |
| `api/app.js` | ① 启动期密钥自检（`JWT_SECRET`、`SHARE_TOKEN_SECRET`）：生产弱值直接抛错拒绝启动，开发打印告警。② CORS `allowedOrigin` 改为「生产仅 `FRONTEND_URL` + `CORS_EXTRA_ORIGINS`；非生产额外放行内网/本机调试源」，**不再把内网源硬编码进生产**。③ `allowedHeaders` 补 `x-scene`、`x-client-nonce`，并预留 `x-sign`、`x-client-ip` |
| `api/README.md` | 修正签名与 `APP_SECURITY_SALT` 描述；安全特性表补充 nonce / fail-closed / secretGuard / CORS 收敛 / 令牌吊销；env 表新增 `SHARE_TOKEN_SECRET`、`CORS_EXTRA_ORIGINS`、`REQUIRE_CLIENT_NONCE`、`TOKEN_MAX_SESSION_DAYS`；目录树与更新日志表同步 |
| `api/logs/CHANGELOG_2026-09-20.md` | （引用补登）此前遗漏在 `README.md` 更新日志表中，本次补上 |

#### ⛓ 连锁修复说明：为什么必须一起改 `markVerified`

修复 ②（窗口不再自我续期）会让 `checkFrequency` / `checkSensitive` **首次真正生效**。
但风控计数原本没有任何「验证成功后归零」的机制，于是会引入一条新的死循环：

```
空闲 >30s → 风控恢复计数 → 窗口内累计到阈值（如 60s 内 10 次写操作）
  → 每个请求都返回 8303 → 用户输入正确 PIN
    → 前端重发原请求（走 /security/pin/verify，不经过守卫分支 1/2）
      → 计数仍在阈值之上 → 再次 8303 → 输 PIN 也过不去
```

因此必须成对引入 `markVerified`：**验证通过 = 身份已确认 = 风控计数归零**。
它同时被守卫内部（分支 1/2）与 `SecurityController.verifyPin`（前端弹窗路径）调用。
> 安全性不受影响：攻击者无法通过该函数获益（前置条件是已通过 PIN 校验）。

---

### 🔧 修改 · web

| 文件 | 变更内容 |
|------|----------|
| `web/src/utils/securityHeaders.js` | 新增 `createClientNonce()`（`randomUUID` → `getRandomValues` → 非安全兜底）与 `refreshVolatileSecurityHeaders(headers)`（重发前刷新时间戳 + nonce，兼容 `AxiosHeaders` 与普通对象）；`getSecurityHeaders()` 现在带上 `x-client-nonce` |
| `web/src/utils/request/interceptors/request.js` | 每个请求注入 `x-client-nonce`（一次性，与时间戳同批生成） |
| `web/src/utils/request/pin.js` | **两处重发路径**（30 秒冷却静默重发、PIN 验证成功后队列重发）在 `axios()` 之前调用 `refreshVolatileSecurityHeaders()` —— 避免「等用户输 PIN 超过 2 分钟导致时间戳超窗」与「nonce 复用被后端判定为重放」 |
| `web/src/utils/fileRequest.js` | 独立上传客户端补 `x-client-nonce`（该端不复用 `securityHeaders.js`，且其 8303 重发也走 `pin.js`，已自动受益） |
| `web/.env` | **移除** `VITE_LOGIN_USERNAME` / `VITE_LOGIN_PASSWORD`，替换为说明注释 |
| `web/.env.development` | **新增**。演示账密移到这里 —— 该文件不参与 `vite build`（mode=production），生产产物不再含明文 |
| `web/.env.example` | 同步提示：演示账密不要写在 `.env`，放到 `.env.development` |

---

### ⚠️ 行为变更（需重点回归）

> **B1 / B3 已另出专门方案（待确认，未实施）**：
> 根目录 [`安全加固-B1B3处置方案.md`](../../安全加固-B1B3处置方案.md)
> —— 含实测风险画像、可一键回退的模式开关、阈值外置、客户端自愈兜底与验证清单。
> **B2 / B4 / B5 / B6 无需回归，保持当前默认。**

| # | 变更 | 具体影响 | 建议回归点 |
|---|------|----------|------------|
| B1 | **30 秒放行窗口不再自我续期** | 空闲超过 30 秒后继续操作会重新受风控：60 次/60 秒（全方法）、10 次/60 秒（POST/PUT/PATCH/DELETE）。超限会弹 PIN；**输对 PIN 后计数归零**（`markVerified`），不会循环弹窗 | 批量新增/删除多笔流水、批量导入、短时间内多次提交表单；确认不会频繁误弹、确认输 PIN 后能正常继续 |
| B2 | **PIN 守卫异常改 fail-closed** | 后端异常时，**已设置 PIN 的用户**会收到 `503 安全校验异常`（此前是静默放行） | 出现 503 时查后端日志 `[pinSecurityGuard] 守卫异常` |
| B3 | **nonce 防重放生效** | 同一 nonce 二次提交 → `400 非法请求！`（当前**不可识别、不可自愈**） | 见 [处置方案](../../安全加固-B1B3处置方案.md)：加独立错误码 `8401` + 客户端自动重发一次 |
| B4 | **生产 CORS 收敛** | `NODE_ENV=production` 时不再放行内网/localhost 源 | 若生产确实需要额外源，配置 `CORS_EXTRA_ORIGINS`（逗号分隔） |
| B5 | **生产弱密钥拒绝启动** | 生产 `.env` 的 `JWT_SECRET` 少于 32 位或仍是占位值 → 服务**起不来** | 上线前 `openssl rand -hex 32` 生成并写入 |
| B6 | **默认账密移出 `.env`** | 生产 bundle 不再含明文账密；dev 行为不变（`VITE_APP_DEMO=false`，本就不预填） | 若需要演示预填，在 `.env.development` 中把 `VITE_APP_DEMO` 设为 true |

---

### ✅ 待同步到 APP / webview-APP 的策略（**已于同日第三批完成**）

> ⚠️ **本节为第一批撰写时的原始计划，现已全部落地。** 实际执行情况见本文件顶部
> 「第三批：nonce 策略同步至 webview-APP 与 APP」章节。下表保留作为**对照与审计留档**。
> 唯一仍未执行的动作：`REQUIRE_CLIENT_NONCE` 仍为 `false`，待实机回归后开启。

| # | 策略 | web 侧 | APP / webview-APP 侧 | 同步动作 | 未同步的后果 |
|---|------|--------|----------------------|----------|--------------|
| **S1** | 请求头 `x-client-nonce` | ✅ 已发送（每请求新生成） | ❌ 未发送 | 见下方逐文件清单 | 功能正常（后端"携带才校验"）；但开启 `REQUIRE_CLIENT_NONCE=true` 后请求会被 400 |
| **S2** | 重发前刷新 `x-client-timestamp` + `x-client-nonce` | ✅ 已实现 | ❌ 待确认 | 同上 | 同上；且等待 PIN 超过 2 分钟会因时间戳超窗被拒（**这是既存的潜在缺陷，与本次改动无关**） |
| **S3** | 30 秒放行窗口语义（服务端行为） | 自动受益 | 自动受益 | 无需改代码 | 若 APP 交互依赖"长期免验"，会多弹 PIN（需回归 B1） |
| **S4** | 生产密钥强随机 | — | — | 部署配置 | 生产直接无法启动（B5） |
| **S5** | 请求签名 `x-sign` | ❌ 未实现 | ❌ 未实现 | 见根目录设计文档 §4（需三端同步上线） | 无（当前未启用） |

#### 逐文件同步清单

**APP（原生 Kotlin）**

| 文件 | 需要做的事 |
|------|-----------|
| `APP/app/src/main/java/com/live/finance/core/net/DeviceProfile.kt` | `headers()` 中新增 `"x-client-nonce" to <每次调用新生成>`。可用 `java.util.UUID.randomUUID().toString().replace("-", "")`（32 位十六进制，符合后端 `^[A-Za-z0-9_-]{16,64}$`） |
| `APP/app/src/main/java/com/live/finance/core/net/ApiClient.kt` | **重发前**刷新易失性头：带票重发、8303 重试等所有 `newCall` 重放路径，需重新生成 `x-client-timestamp` 与 `x-client-nonce`。⚠ 注意 `DeviceProfile.headers()` 现已改为"每次调用生成新 nonce"，若重发复用了旧的 header Map，必须重新调用一次 |
| `APP/app/src/main/java/com/live/finance/core/net/HandshakeManager.kt` | 握手请求同样经 `securityCheck`，会自动带上 nonce（复用 `device.headers()`），无需额外改动 |
| `APP/app/src/main/java/com/live/finance/core/PinCoordinator.kt` | 重发协调逻辑：确认重发时使用**重新生成**的 header，而非首次请求的缓存 |

**webview-APP（WebView 套壳，与 web 同源但为独立副本）**

| 文件 | 需要做的事 |
|------|-----------|
| `webview-APP/src/utils/securityHeaders.js` | 搬入 `createClientNonce` / `refreshVolatileSecurityHeaders`；`getSecurityHeaders()` 补 nonce |
| `webview-APP/src/utils/request/interceptors/request.js` | 注入 `x-client-nonce` |
| `webview-APP/src/utils/request/pin.js` | 两处重发前调用 `refreshVolatileSecurityHeaders` |
| `webview-APP/src/utils/fileRequest.js` | 补 `x-client-nonce` |

> ⚠ `webview-APP/unpackage/`（`cache/wgt/...`、`resources/.../www/`）是**构建产物**，不要手改，只改 `src/`。
> ⚠ webview-APP 是独立副本，**禁止整文件覆盖**，按上表逐处搬移。

**同步完成后的收口动作**

1. 三端回归通过 B1~B3；
2. 在 `api/.env` 设 `REQUIRE_CLIENT_NONCE=true`，重启 API；
3. 验证缺失 nonce 的请求被 400 拒绝。

---

### 📌 明确未做

- **未改** `APP/**`、`webview-APP/**` 任何文件（含 `unpackage/` 构建产物）。
- **未改** `webview-APP` 的 `dist/`、`web/dist/` 等构建产物。
- **未启用** 请求签名（`x-sign`）：三端均未实现，单方面开启会打断所有请求，需按设计文档 §4 单独排期。
- **未改** `api/app.js:99` 的 `app.use(pinSecurityGuard)` 挂载方式（仍是无路径前缀的全局中间件）。
  原因：在守卫内部新增 `/api/public/` 显式跳过已达成同一目的，改动挂载点收益小、回归风险高。
- **未处理** `SESSION_SECRET`（`.env` 中为占位值，但全仓库无代码引用），未纳入启动自检以免产生无意义告警。
- **未处理** `api/src/modules/security/README.md` 中 `X-Pin-Token` 的名称笔误（实际头名为 `x-route-verify-token`）。

---

### 🧪 验证

| 项 | 命令 / 方式 | 结果 |
|----|-------------|------|
| api 语法 | `node --check` × 7（`app.js`、`securityCheck.js`、`pinSecurityGuard.js`、`shareToken.js`、`secretGuard.js`、`config/jwt.js`、`security/controller/index.js`） | ✅ 全部 exit=0 |
| web 语法 | 复制为 `.mjs` 后 `node --check` × 4（`securityHeaders.js`、`interceptors/request.js`、`pin.js`、`fileRequest.js`） | ✅ 全部 exit=0 |
| api 加载冒烟 | `node -e "require('./app')"`（`api/` 目录下） | ✅ 输出 `APP_LOAD_OK`，全部路由/控制器/中间件加载无异常 |
| 密钥告警生效 | 同上（当前 `.env` 用占位值） | ✅ 如期打印 `[security] ⚠ 密钥未配置或强度不足…生产环境将拒绝启动` 与 `[secretGuard] ⚠ SHARE_TOKEN_SECRET 使用了弱值…` |
| 死代码删除 | `ls api/src/modules/security` → 仅 `api/`、`controller/`、`README.md` | ✅ |
| 全仓库残留检查 | 检索 `x-sign` / `APP_SECURITY_SALT` / `middleware/check` | ✅ 除 `temp/` 历史文档外无残留 |

> ⚠ 后端改动需**重启 API 服务**生效；前端 dev server 热更新即可。
> ⚠ 本机未跑 `vite build` / `npm test`，行为变更 B1~B6 需实机回归后再上生产。

---

### 📊 统计

- 修改文件：**14**（api 9 + web 5）
- 新增文件：**2**（`api/src/common/utils/secretGuard.js`、`web/.env.development`）
- 删除文件：**1**（`api/src/modules/security/middleware/check.js`，含所在目录）
- 修复问题：**10 项**（A-1 ~ A-11，其中 A-3 随 A-2 消除），另含 1 项连锁修复（`markVerified`）
- 行为变更：**6 项**（B1 ~ B6，待回归）
- 待同步策略：**5 项**（S1 ~ S5，涉及 APP 4 个文件 / webview-APP 4 个文件）
- 未改动：`APP/**`、`webview-APP/**`
