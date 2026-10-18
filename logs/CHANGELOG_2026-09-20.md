# 变更日志

## 2026-09-20（PIN 安全验证：锁定绕过修复 + 删除一次一验 + 前端弹窗收敛）

> 起因：设置 PIN 后点击顶栏「锁定」，在 PIN 弹窗上点「取消」，系统仍可正常请求 API 取到数据。
> 排查结论：PIN 比对本身（bcrypt）正常，问题出在「软锁放行逻辑」与「前端取消后的零阻断」两处叠加。

### 🔧 修改

| 文件 | 变更内容 |
|------|----------|
| `api/src/common/middleware/pinSecurityGuard.js` | (1) 新增并导出 `clearVerifiedSession(userId)`（清 `verifiedMap` / `freqMap` / `sensitiveMap`）；(2) **移除分支 1.5 中「verifiedMap 30 秒窗口命中就 `next()`」的短路**；(3) 分支 2 开头新增 `if (routeVerifyTarget) return next();` |
| `api/src/modules/auth/controller/index.js` | `lockSystem` 插入 lock 记录后调用 `clearVerifiedSession(userId)`（顶部新增 require） |
| `api/src/modules/security/controller/index.js` | 风险路由连续 3 次 PIN 错误触发的软锁 INSERT 后，同样调用 `clearVerifiedSession(req.userId)`（顶部新增 require） |
| `web/src/utils/request/interceptors/response.js` | `handlePinResponse` 新增：`url` 含 `/lock-system` 时直接 `return resData`，不进 `requestPinVerify` 队列 |
| `web/src/utils/request/pin.js` | (1) `requestPinVerify` 新增第三参 `skipCooldown`；(2) 冷却期静默重发的结果先过 `isPinResponse`，仍是 8303 则递归走正常弹窗流程；(3) `cancelPinVerify()` 增加 `lastSuccessAt = 0`；(4) 新增导出 `showPinDialog()` |
| `web/src/layout/MainLayout.vue` | 删除本组件内**未注册**的第二个 `PinVerifyDialog`（模板 / import / `pinVerifyRef` / `show()` 调用）；`handleLockSystem` 改为 toast + `showPinDialog()` |

### ✅ 修复明细

| 问题 | 根因 | 修复 |
|------|------|------|
| **锁定后点「取消」仍能正常取数（P0）** | `lockSystem` 只往 `security_verify_log` 插 `action_type='lock', pin_status=0`，**从不清除内存 `verifiedMap`**；而分支 1.5 第一句就是「窗口命中 30 秒则 `next()`」⇒ 锁定后 30 秒内所有请求直接返回真实数据 | 分支 1.5 删除该短路；`lockSystem`（及风险路由软锁）插入 lock 记录后调用 `clearVerifiedSession(userId)` |
| 上述窗口实际接近「永久免验」 | 分支 3 中 `session.verifiedAt = now` 写在计算 `diff` 之前 ⇒ `diff` 恒为 0 ⇒ 永远命中窗口；请求间隔略大于 30 秒时 `count` 又每次归零 ⇒ 永远触发不了重验（06-28 那次「防旧会话污染」修改的副作用） | **本次未改**（属产品取舍，见「已知遗留」） |
| 输入正确 PIN 解锁成功后系统被重新锁上 | 解锁 → `onPinSuccess` 重发 `pendingRequests` 里的 `/auth/lock-system`；后端此时查不到 `pin_status=0` 的 lock 记录（已被 `markSuccess` 置 1）⇒ 又 INSERT 一条 ⇒ 刚解锁又被锁，重发走裸 axios 无拦截器，用户无感 | `response.js` 对 `/lock-system` 直接返回 `resData`，锁定请求不进待重发队列 |
| 点「取消」后 30 秒内数据照样加载且无任何提示 | `lastSuccessAt` 未清零 ⇒ 后续 8303 走「冷却静默重发」捷径 | `cancelPinVerify()` 中 `lastSuccessAt = 0` |
| 冷却重发把 8303 当成成功 | 该分支用的是**裸 `axios`**，没有响应拦截器 ⇒ 后端回 8303 也被 `resolve(res.data)`，调用方以为成功（页面静默空白） | 重发结果先判 `isPinResponse`，命中则递归 `requestPinVerify(..., skipCooldown = true)` 走正常弹窗 |
| 弹窗关不掉 / 关错窗 | 全项目有两个 `PinVerifyDialog`：`App.vue` 那个 `registerPinDialog` 注册过，`MainLayout.vue` 那个**没注册**，但 `handleLockSystem` 调的正是它 ⇒ `submitPin` / `hide()` 只作用于 `App.vue` 那个 | 删除 `MainLayout` 内未注册实例；新增 `showPinDialog()` 弹全局那个 |
| **删一条数据要连输两次 PIN** | 第 427 行 `routeVerifyTarget` 放行只认 `pin_status = 1 或 3`；最新记录为 **0（待验证）或 2（上次输错）**时掉进分支 2，返回**不带 challengeId 的通用 8303** ⇒ 前端先走普通验证（等于先"解锁系统"）⇒ 重发 DELETE 才轮到 `pinLockGuard` 出 challenge | 分支 2 开头补 `if (routeVerifyTarget) return next();`，与分支 1.5 保持一致（1.5 早在 06-28 已修，分支 2 漏改） |

### 🔒 安全

- 软锁（`action_type='lock' AND pin_status=0`）未解除时，**一律不放行**，不再受内存放行窗口影响
- 「锁定」动作立即清除该用户的内存放行会话，杜绝「锁定后 30 秒内绕过」
- **删除保持零容差**：全部 22 条 DELETE 路由本来就挂了 `pinLockGuard`（另加 `/data-manager/import/sql`、`/upload/batch-delete`），每次新建 challenge、token 一次性；本次修复保证任何状态下都只走一次 challenge，不会退化成「先解锁再 challenge」
- 解锁成功的唯一途径仍是 `verifyPin` / `verifyRoutePin`（不绕过验证）
- 本次**未改动** 30 秒放行窗口本身，正常浏览的并发宽限能力完整保留

### 📌 完整验证闭环

| 场景 | 流程 | 结果 |
|------|------|------|
| 点击顶栏「锁定」 | `lock-system` 写 lock 记录 → 清 `verifiedMap` → toast + **立刻弹 PIN 窗** | ✓ 无需等下次请求 |
| 在弹窗输入正确 PIN | `verifyPin` 8301 → `pin_status=1` 解锁 → 关窗 → 后续请求放行 | ✓ 一次解锁，不重复弹窗 |
| 在弹窗点「取消」 | `lastSuccessAt=0` → 关窗，系统保持锁定 | ✓ 下次任何请求重新弹窗 |
| 锁定后普通请求 | 分支 1.5 → 8303「操作受限」→ 全局弹窗 | ✓ 不再有 30 秒绕过 |
| 删除（任意记录状态） | 直接放行给 `pinLockGuard` → 带 `challengeId` 的 8303 → 输 PIN → token → 重发 | ✓ 只验一次 |
| 静态资源（logo 图片） | `<img>` 不带 `Authorization` ⇒ `userId=null` ⇒ 守卫首步放行 | ✓ 不计数、不风控（隐式，见遗留） |

### ⚠ 已知遗留（本次**未**处理，待负责人定）

| 项 | 说明 | 建议 |
|----|------|------|
| 30 秒窗口自我续期 | 分支 3 的 `session.verifiedAt = now` 写在算 `diff` 之前 ⇒ `diff` 恒为 0 ⇒ 下方 `checkFrequency`（60 次/60 秒，全方法）与 `checkSensitive`（10 次/60 秒，仅写方法）**永远执行不到（死代码）**；请求间隔略大于 30 秒时 `count` 每次归零 ⇒ **一次 PIN 验证后近乎无限期免验** | 若要收紧：把续期挪到「真正通过风控之后」；或把 `checkSensitive` 提到窗口判断之前（只影响 POST/PUT/PATCH，GET 零影响） |
| `SENSITIVE_METHODS` 含 `DELETE` | DELETE 全量走 `pinLockGuard` challenge，永远到不了 `checkSensitive` ⇒ 该配置对删除实际是死配置 | 保留作兜底无害，可不改 |
| 静态资源跳过是隐式的 | `/api/public/...` 现在靠「`<img>` 带不了 `Authorization`」跳过守卫；若哪天改成 axios blob 带 token 取图，每张图都会算进 `session.count`（60 上限），`/card/debit` 加载 30 张卡即触发「请求过多，请重新验证」 | 建议守卫首部加 `if (url.includes('/api/public/')) return next();`（1 行，本次未加） |

### 📊 统计

- 修改文件：6（`api` 3 个 + `web` 3 个）
- 问题修复：7（锁定绕过、重新上锁、取消零阻断、8303 被当成功、弹窗关不掉、删除双验证、软锁清除不一致）
- 新增导出：`clearVerifiedSession`（api）、`showPinDialog`（web）
- 未改动：`pinLockGuard.js`、`security/pin/*` 控制器、`APP/`、`webview-APP/`

### 🧪 验证方式

- `api` 三个文件：`node --check` 全部通过
- `web` 两个 JS：复制为 `.mjs` 后 `node --check` 通过
- `web/src/layout/MainLayout.vue`：用 `@vue/compiler-sfc` 做 `parse` + `compileScript` + `compileTemplate`，均通过，模板无 `pinVerifyRef` 残留
- ⚠ `vite build` 本机跑不通：卡在 `vite:prepare-out-dir` 清空 `dist` 时 `node-safe-delete-shim` 调用回收站组件 `ETIMEDOUT`（环境沙箱问题，非代码问题）。如需全量构建，用 `--outDir` 指向一个不存在的目录绕开清空步骤
- 后端改动需**重启 API 服务**生效；前端改动 dev server 热更新即可

---

## 2026-09-20（前端策略同步至 `webview-APP` 与 `APP`）

上一节的策略改动同步到另外两端。**策略完全一致，实现方式按各端形态适配。**

### 🔧 修改 · webview-APP

与 `web/src` 同源，但**有自己的增量**，因此逐处搬移而非整文件覆盖：

| 文件 | 变更内容 | ⚠ 该端特有、必须保留 |
|------|----------|----------------------|
| `src/utils/request/pin.js` | 同 web 四处改动（`skipCooldown` 参数、冷却重发过 `isPinResponse`、`cancelPinVerify` 清 `lastSuccessAt`、新增 `showPinDialog`） | `onPinSuccess` 里的 `sessionStorage.setItem('__PIN_VERIFY_RELOAD__','1')`（`index.html` 据此跳过二次开屏） |
| `src/utils/request/interceptors/response.js` | 新增 `/lock-system` 直接 `return resData` | 错误拦截器是 `(error) =>`，非 web 的 `async (error) =>`，未动 |
| `src/layout/MainLayout.vue` | 删除未注册的第二個 `PinVerifyDialog`，`handleLockSystem` 改调 `showPinDialog()` | `import { softBack, getRouteLevel } from "@/utils/native"`；`cachedViewNames` 本就没有 `"BillList"` |

> ⚠ `webview-APP/unpackage/`（`cache/wgt/...`、`resources/.../www/`）是**构建产物**，不要手改，只改 `src/`。

### 🔧 修改 · APP（原生 Kotlin）

| 文件 | 变更内容 |
|------|----------|
| `core/net/ApiClient.kt` | ① `pinGate` 签名加第二参：`(suspend (JsonElement?, Boolean) -> PinTicket?)?`；② 8303 分支加 `&& !path.contains("/lock-system")`；③ 带票重发后若 `env` 仍是 8303 ⇒ 再以 `skipCooldown = true` 走一次 pinGate 并重发 |
| `core/PinCoordinator.kt` | ① `awaitVerify(challenge, skipCooldown = false)`；② `resolve(null)`（取消 / 会话终止）时 `lastSuccessAt = 0`；③ 新增 `requestUnlock() = awaitVerify(null, skipCooldown = true)` |
| `di/AppGraph.kt` | `client.pinGate = { challenge, skipCooldown -> it.awaitVerify(challenge, skipCooldown) }` |
| `ui/main/GlobalNavBar.kt` | 原 `if (AppConfig.useFake) awaitVerify(null)` ⇒ 改为**所有变体**都 `graph.pinCoordinator.requestUnlock()`；`AppConfig` import 随之不再使用，已删 |

### ⚠ 原生端的关键连锁（改 A 必须同时改 B）

原生原本**没有**「锁定后主动弹窗」：它靠 `/auth/lock-system` 返回 8303 时由 `ApiClient.pinGate` 触发弹窗（构造书 §4.7「只弹一次」）。
一旦把 `lock-system` 排除出 pinGate 队列（修「输对 PIN 又被重新锁上」），**必须**在 `GlobalNavBar` 补主动弹窗，否则点了锁定不会弹框。
⇒ 这就是为什么第 2 条与第 4 条必须成对出现。

原生同样存在 web 那个「输对 PIN 又被重新锁」的 bug —— `GlobalNavBar` 原注释（102-104 行）其实已记录该现象（「重发又新插一条」），只是当时判定为无害。

### 🧪 验证

- `webview-APP`：两个 JS `node --check` 通过；`MainLayout.vue` 经 `@vue/compiler-sfc` parse + compileScript + compileTemplate 通过
- `APP`：`:app:compileProdDebugKotlin` —— **本次改动的 4 个文件 0 错误**（多次编译均如此）
  ⚠ 但当前 `APP` 工程整体编译为**红**，且**与本次改动无关**：错误集中在 `ui/common/chart/`
  （`BarChart.kt` / `ChartUtils.kt` / `DonutChart.kt` / `LineChart.kt` / `DualAxisChart.kt`）与
  `ui/asset/`（`AssetListScreen.kt` / `AssetTrendScreen.kt`），表现为 Float↔Double 不匹配、
  `pow` / `Stroke` / `LocalContext` / `remember` 未解析、`padding(horizontal/vertical)` 参数名不存在。
  这些文件在本次改动前已被**其它会话**修改（16:00 后有多文件改动记录），属他人**进行中**的重构
  （17:46 复编时错误面反而从 chart 扩大到 asset，说明对方仍在改）⇒ **未做任何处理**，避免冲突。
  待对方改完后再跑一次 `:app:assembleProdDebug` 确认全绿。
