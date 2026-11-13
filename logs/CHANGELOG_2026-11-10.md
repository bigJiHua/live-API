# 2026-11-10 变更日志（合并）

> 本文件由当日独立日志按日期合并，来源见各节标题。

---

## 来源：CHANGELOG_2026-11-10_AI_AGENT_CAPABILITIES_PLAN.md

# AI Agent 基本能力补全计划编制 — 2026-11-10

用户要求按 `agent.md` 文档规范将 agent 基本功能缺口（A calc / B failover / C eval / D proactive）列成计划落根目录，待基本盘稳固（追加166 六步路线图剩余 3/4/5）收口后再执行。本轮仅编制 [PLAN_AI_AGENT_CAPABILITIES.md](../../PLAN_AI_AGENT_CAPABILITIES.md)，没有运行测试、付费模型、DB/API 或浏览器，没有修改生产源码。

计划覆盖四项缺口（每项含目标/方案要点/改动清单/验收/可直接复制的 TASK_INPUT）与暂缓池两项（E 通用图片理解、F 语音输入，待产品拍板）；web_search 已定自建路线单列为 §7 关联项，不占 A–D 编号。执行顺序 A→B→C（B/C 可并行）→ web_search → D 立项，并约定任一项验收不过不进下一项。

只读核实支撑计划的四个事实：原生工具 8 个且无计算类工具（`v3Tools.js`/`memoryTools.js`/`historyTools.js`）；工具注册与分发单点在 `v3Service.js:74,665` 且 `budget.tool` 钩子现成；`config.js:6` 单 active base 无备用槽位（当前商汤 sensenova-6.8-flash，`api/.env:149-150`）；日预算按 userId 管控（`requestGuard.js:214,310`）。联网搜索的供应商侧核实（商汤无内置 web_search、DeepSeek ¥5/千次、智谱 0.01/次起）见当日会话核对，均写入计划 §1/§7。

A/B/C 的 TASK_INPUT 已按 `agent.md` §5/§9 模板写成可复制格式；D 为立项级，动工前需另出专属 PLAN 扩写。本文档与计划均无执行证据，后续各项动工时在计划顶部追加状态行并沿用现有日记惯例。

---

## 来源：CHANGELOG_2026-11-10_AI_ALL23_BOUNDED_ACCEPTANCE.md

# 2026-11-10 财务助手 23 数据集有界收尾

最终代码已加载 life-assistant-v4.20，服务沿用 5173/7788。按照用户“不要自我循环和过度测试”的要求，停止全矩阵重复付费，完成直接失败、必要前置、持久化回读及验收文档。根报告：[AI_ALL23_ACCEPTANCE.md](../../AI_ALL23_ACCEPTANCE.md)。

## 本次最终代码修复

- `memoryClaimVocabulary.js` 共用中文记忆/偏好及 English memory/preferences 名词；`memoryClaims.js` 和 `memoryReadStateClaims.js` 引用同一词类，修复成功读取 saved preferences 被误改为“本轮未保存”的问题。真实读取/搜索回执、未知文件、时间戳、当前写入与业务完成声明的护栏保持。
- `v3Prompt.js` v4.20：区分业务取数与纯记忆任务。记忆内容足够后直接结束工具阶段，避免 memory_search/read 后再调用 finance list_choices；保留图表横轴/纵坐标、答复语言与本轮任务指导。
- `aiMemoryReadStateClaims.test.js` 增加直接失败及无回执、未知文件、当前写入反例；`aiV3MemoryReadStateReplay.test.js` 增加 saved preferences 的真实工具回执整链路控制；`aiV3Service.test.js` 同步版本。

前轮已合入能力注册表、SQL 全范围筛选/极值排序、预览列白名单、有效参数与覆盖元数据、多主体任务及历史上下文、单次工具恢复、卡数量/消费粒度、空结果与分期状态、Markdown 记忆和读取措辞修复。本次没有重复应用旧候选或放宽预算。

## 验证结果

- API 当前源码 163 套 / 3860 项全部通过；Web 180 项复用已有通过报告，30 个源文件和 19 个测试/fixture 字节一致。报告：`temp/ai-all23-20261109/api-regression-v12-bounded-final.json`、`bounded-final-regression-review.json`。
- 商汤 `sensenova-6.8-flash` 最后 4 请求 / 12 次供应商调用 / 109765 reported tokens；没有 DS：N03、C03、M06 原 runner passed；M05 原 failed 保留。
- N03/C03 实际 June both 范围、268 匹配/10 展示、153 支出/115 收入及图表绑定正确。C03 同日多柱解释已纠正；正文明细重复和十笔范围说明不够直接保留关注。
- M05 保存的 English、红色、否定蓝色事实读回正确，原始最终正文与用户可见正文一致；原 red 断言不接受“红色”，同时存在英文提问中文答复的真实偏差。M06 literal English 搜索完整原文正确，未调用无关业务工具。
- 查询 2 请求的回执重复读取/1 聊天恢复、记忆 19 次尝试/19 聊天/38 次回执读取、同 body 2 次重放和不同 body 2 次 409，均 0 新模型调用。
- 历史 23 数据集共 123 个场景均有真实执行证据，跨版本最新原记录 122 passed/H23 failed；H23 独立语义复核为“不证明”词面误拒。没有将旧 capture 升级为最终 sourceDigest，也未关闭原同 hash 全矩阵 gate。

## 业务快照的真实限制

23 张本人非 AI 表：21 张与最早基线一致；`account_balance` 85 行 digest 变化，`user_log` 243→244。只读查到普通登录及 `GET /accountBalance` 活动，普通余额接口 `getList → verifyAndSync` 会重算并 UPDATE；AI `businessRead` 直接 SELECT 快照。不能宣称整轮 23 表全部不变，不能从 digest 推断操作者或逐项余额值。最后四个测试聊天的新草稿/提案/交易候选均为 0。未回滚业务数据或改基线。

记忆写入全部位于 `temp/ai-all23-20261109/memory-live-isolated-a59eaeb7bc03`，没有污染正式 `api/data/memory`。浏览器为实际组件预览，不冒称已登录完整助手验收。15 kind 正式业务执行不属于只读测试授权，本轮未执行。

冻结 sourceDigest：`f4e8a27090298916cfa3da36c80abc1e55bbd3285c917762e0be84ce0c32b164`。完整参数、请求、版本、计数和已保留不足见根验收报告。后续只有明确新失败才针对复现；本轮不追加付费或重复回归。

---

## 来源：CHANGELOG_2026-11-10_AI_API_CLOSEOUT.md

# AI API 收尾变更与实效验证 — 2026-11-10

用户授权直接 API 验证，调用商汤 sensenova-6.8-flash，沿用 5173/7788。生产修复包括 responseLanguage、queryChartCoverage、memorySearchCompletion、memoryStore/memoryRegexWorker 的逐行截断标志，以及 memoryReadStateClaims 的标签与已有状态解析。

本轮 18 个独立场景最新实测通过，21 次尝试 / 56 次供应商调用 / 471848 reported tokens；保留供应商与正文清洗失败。预算提案最终 discarded，无正式入库。正式业务 23 表在本轮快照范围完全一致，记忆写入使用 temp 隔离目录。

完整 API 回归 169 套/3947 项通过（标签修复 hash）；最终已有记忆语法修复后 6 套/307 项直接影响链通过。没有把这些结果迁为最终 hash 全 123 场验收。

新增真实 M07 两种错误响应 fixtures 和回放：标签式文件名、带空格和引号名称、未知文件/Unicode 前缀/未知第二文件、拥有者限定已保存记忆及当前写声明。有效正文保持原文；历史与恢复一致。原 API_AMOUNT_NOT_EXPLICIT 等护栏未放宽。

8 查询与 12 次记忆尝试通过真实 HTTP 双回执/前端历史恢复，预算幂等及取消状态也正确，回读新增供应商调用 0。

当前 life-assistant-v4.21，sourceDigest c4bd1985cc53db827919c0b8a1e50a63bea3901c40b2eab10197d5b1edbaf4ba。细节和请求标识见 [API 实效报告](../../temp/ai-api-closeout-20261110/API_CLOSEOUT_REPORT.md) 与 [机器证据](../../temp/ai-api-closeout-20261110/api-closeout-report.json)，总体报告见 [AI_ALL23_ACCEPTANCE.md](../../AI_ALL23_ACCEPTANCE.md)。

剩余覆盖：15 类提案正式执行/回滚、最终同 hash 全矩阵、记忆并发与坏文件/超时实际供应商链。所有本轮请求已终态，按用户要求停止重复测试。

---

## 来源：CHANGELOG_2026-11-10_AI_CHART_SYNC_LOOP.md

# 图表协议冲突引发前端重复恢复修复（2026-11-10）

## 根因

用户报告 5173 发送一句后，回执、历史和同步反复显示“图表必须绑定本次返回的数据”。只读检查定位到已保存消息 `2698`：`finance-monthly` 饼图携带 `income/expense` 两个指标，查询标识和数据列均存在。前端饼图只允许一个指标，后端 `validateChart` 未检查这一条件，因此保存了前端无法展示的图表。

同一成功结果被发送终态、恢复回执、历史和 SSE 校验重复读取，异常阻止同步游标前进；同步重连又取到同一条消息。回执错误的自动读取虽有次数上限，仍会重复失败，造成持续请求和相同提示。该提示来自前端校验，不能据此判定所有后端接口都返回相同错误。

## 修复

- `api/src/modules/ai/service/v3Service.js`：多指标或包含负数的饼图不返回图表，保留本轮数据及正文，附说明。不擅自选收入/支出中的一个指标，不新增模型调用。单指标合法饼图和多指标柱状/折线图保持正常。
- `web/src/utils/aiBusinessContract.js`：严格校验默认保留；API 的展示选项仅隔离不可渲染的可选图表，返回 `chart:null` 与局部 `chartNotice`。数据、请求预算、草稿和归属标识仍需正常通过协议校验。非法数据集与非法调用预算不能通过此选项被接受。所有纯协议异常带 `AI_RESPONSE_INVALID / kind=protocol`，与网络故障区分。
- `web/src/utils/api/ai.js`：发送、流式终态、回执、历史、会话和同步统一使用上述展示选项；请求编号不一致也归类为协议异常。回执中的规范化结果实际返回给页面。
- `web/src/utils/aiBusinessHistory.js` / `views/AI/Assistant.vue`：旧坏图表恢复时保留正文、查询数据和原消息身份，明确清空不可用图表，显示局部提示；原持久化记录和用户输入框草稿不改写。
- `web/src/utils/aiConversationSync.js`：永久协议异常停止订阅、兜底轮询和自动重连，保留游标，显示页面提示；网络故障仍按原退避策略重连。重新打开会话或刷新可重新尝试。
- `web/src/utils/aiTurn.js`：回执协议错误停止自动读取，保留手动恢复入口；不自动重新发送模型请求。

## 验证

- 对实际消息 `2698` 只读验证：严格模式仍拒绝双指标饼图；展示模式正常恢复结果、完成回执、历史与同步，两份数据集保留，原图表仍有两个指标，`databaseWrites:0 / providerCalls:0`。证据：`../../temp/ai-chart-loop-persisted.txt`。
- 读取当前 `http://127.0.0.1:5173/src/utils/aiBusinessContract.js`、`api/ai.js`、`aiConversationSync.js` 均为 200 且包含本次修复，确认当前 Vite 提供新代码。没有接管用户未连接的浏览器，也没有发送新模型消息。
- 前端 `npm run test:ai`：160 项通过，含同一旧图表覆盖所有 API、页面同步恢复、数据/预算继续拒绝，以及订阅/兜底/应用协议异常不重连。
- 图表渲染专项：16 项通过，覆盖现有饼图、区间排名、精确小数和逐卡月度序列。证据：`../../temp/ai-chart-loop-chart-tests.txt`。
- 后端 V3/同步/HTTP 定向回归：3 套、133 项通过；完整 AI 回归：179 套、4078 项通过。证据：`../../temp/ai-chart-loop-api-tests.txt`、`../../temp/ai-chart-loop-final-api.txt`。
- 前端生产构建通过，保留既有分块大小与 Browserslist 提示。证据：`../../temp/ai-chart-loop-build.txt`。前端完整回归证据：`../../temp/ai-chart-loop-final-web.txt`。
- 后端历史 Web 合同测试的源码注入器已更新为新的导入别名，继续执行真实严格验证器，未放宽数据库/供应商隔离。

没有更改限流、请求队列、财务执行或数据表。先前同步记录见 [A/B 同步实现](CHANGELOG_2026-11-10_AI_CHAT_DEVICE_SYNC.md)。

---

## 来源：CHANGELOG_2026-11-10_AI_CHAT_DEVICE_SYNC.md

# A/B 设备同一聊天同步修复（2026-11-10）

## 结果

后续发现并修复历史列表中辅助清理的跨表排序规则冲突，已补真实 MySQL 验证；见 [聊天列表 500 修复](CHANGELOG_2026-11-10_AI_CHAT_LIST_COLLATION.md)。下文原实现回归不涵盖该实库差异。

同账号 A/B 设备打开同一会话时，使用鉴权 GET SSE 加只读快照恢复，同步原话、排队/处理阶段、最终消息及当前草稿/提案/候选状态。修复相同原话误去重、异步切会话污染、游标先推进导致漏重取、多卡结果等待气泡残留和候选转换重复卡片。此前只审查的记录保留在 [原审查](REVIEW_2026-11-10_AI_CHAT_DEVICE_SYNC.md)。

## 当前策略

- `/conversations/:id/events?since=编号`：初次发送数据库快照，之后每 2 秒读取变化；有变化才发送 `sync`，删除发送 `deleted`，故障发送 `error`。每 15 秒注释心跳，55 秒结束连接，由前端重新订阅。
- `/conversations/:id/sync?since=编号`：15 秒 GET 兜底及失败恢复。两个接口都只读取，不调用模型、不重放 POST 或业务动作，保持本人会话权限校验。每批最多 200 条消息，满批立即继续补齐。
- 落库 `ai_message` 编号负责消息恢复；每次订阅都重新获取活动和实体版本。没有新增永久事件日志。常规在线更新约 2 秒，模型逐字输出/思考片段不跨端推送，离线期间已结束的活动以最终历史消息恢复。
- 可见当前会话保持一条订阅，隐藏/离开/切换时取消。串行应用快照，成功应用且仍属当前会话后才推进游标。输入框内容按设备保存，历史查询/图表仍是原快照。
- 角色、请求/消息编号和卡片 ID 用于合并；原文不用于判定重复。保留本机消息对象引用以兼容进行中的流式回调。最终首张卡占用原等待气泡，后续卡按 ID 独立；空的独立草稿确认合入原卡并保留历史位置/答复。
- 使用既有 GET 读取当前实体，保留正在本机操作的卡片和更高版本。候选暂时读取失败仍保存身份，后续没有新消息的快照也能恢复；候选转草稿先更新原卡再合并独立消息。
- 远端删除清理旧界面并提示新建，停止旧订阅及本机旧会话连接。活动创建与删除共享会话行锁，删除在原事务内清理活动原话；列表触发的既有 90 天会话清理后补清理孤立活动。

## 后端与迁移

- `src/modules/ai/service/conversationSync.js`：本人范围的 SELECT 快照与活动 CAS。原话字段加密，不存图片字节。只返回活动和版本，不返回执行 token。
- `src/modules/ai/service/v3Service.js` / `index.js`：文字与 OCR 执行记录排队、处理、完成或失败，排队阶段更新先排空后进入运行态；重复请求不能覆盖原执行，终态不允许晚到阶段覆盖。模型调用预算与请求去重保持现有护栏。
- `src/modules/ai/api/index.js`：两个鉴权 GET 同步端点，清理订阅计时器。新表为 `mysql/migrations/024_ai_chat_activity.sql`，定义同步至 `mysql/live.sql`。
- 已在当前配置数据库执行 `npm run ai:chat-sync:migrate`，只重复 CREATE 活动表并登记 `_migrations`，输出 `registered:true / idempotent:true / accountingWrites:0`。未运行完整旧迁移、模型验收或账务写入。其他部署环境需执行同一专项迁移。

## 前端

- `src/utils/request/streamRequest.js`：GET SSE 复用登录 cookie/Bearer、客户端指纹、nonce 等安全头；异步帧按序处理，65 秒客户端连接上限，停止与异常释放 reader/计时器。
- `src/utils/aiConversationSync.js`：生命周期、游标、断线恢复及身份合并；`src/utils/api/ai.js` / `aiBusinessContract.js` 增加 API 与协议校验。
- `src/utils/aiHistory.js` / `aiBusinessHistory.js` 保留消息/请求及候选身份；`src/views/AI/Assistant.vue` 接入快照和当前卡片刷新。

## 验证

- 前端 `npm run test:ai`：153 项通过，含页面脚本真实方法测试、相同原话双端、多卡终态、切会话竞态、候选转换/读取恢复、远端删除和 GET 传输顺序/清理。证据：`../../temp/ai-chat-sync-final-web.txt`。
- 前端 `npm run build`：通过；保留现有大分块与 Browserslist 数据版本提示。证据：`../../temp/ai-chat-sync-final-build.txt`。
- 后端 `npm run test:ai -- --silent`：179 套、4076 项通过，含最终新增的会话行锁与事务删除测试。证据：`../../temp/ai-chat-sync-final-api.txt`；同步存储/HTTP 与 V3 的此前定向回归 120 项通过，见 `../../temp/ai-chat-sync-final-state.txt`。HTTP 用两条实际 SSE 网络连接验证，权威状态由隔离替身提供，未把它描述为两台实体设备实测。
- 增量 schema 专项执行幂等；源码语法与 Git diff 空白检查通过。未覆盖用户其他改动，未增加依赖。

## 配套接纳策略

保留已完成的 [请求接纳策略调整](CHANGELOG_2026-11-10_AI_REQUEST_ADMISSION.md)：同用户串行、短时并发等待、窗口/调用预算及幂等。跨端同步只读取该执行的状态，不通过取消限流或重新发送模型请求实现同步。

---

## 来源：CHANGELOG_2026-11-10_AI_CHAT_LIST_COLLATION.md

# 聊天列表 500：活动清理排序规则修复（2026-11-10）

## 问题与根因

用户报告 `GET /api/v1/ai/conversations 500`。上一轮跨设备同步新增了历史列表之后的孤立活动清理，但未处理新旧表排序规则差异，辅助清理异常直接导致整个历史列表失败。

对当前数据库做只读结构检查与关联 SELECT 复现：

- `ai_conversation.id/user_id` 为 `utf8mb4_general_ci`。
- `ai_chat_activity.conversation_id/user_id` 为 `utf8mb4_unicode_ci`。
- 两表字段直接比较报 `ER_CANT_AGGREGATE_2COLLATIONS / HY000 / Illegal mix of collations`。

## 修复

- `src/modules/ai/service/conversationSync.js`：孤立清理的关联 ID、用户 ID 显式使用 `utf8mb4_general_ci` 比较，兼容已部署的新旧表，不修改数据表排序规则。保留本人范围、有效会话判断及孤立原话清理。
- `src/modules/ai/service/index.js`：历史列表成功读取之后的辅助活动清理失败只记脱敏诊断，`phase=conversation-activity-prune`，仍返回已读列表；历史主查询失败继续正常报错，未隐藏数据读取故障。
- `tests/unit/aiConversationSync.test.js`：新增辅助清理失败仍返回列表、错误留诊断，以及主查询失败仍拒绝的回归。
- `tools/ai-chat-sync-list-verify.js`：可重复运行的真实 MySQL 验证，仅在独立连接创建临时表和合成数据，使用原服务/HTTP 路由。MySQL 临时表不允许在同一语句重复引用，验证将列表计数子查询映射到同内容的另一张临时表；活动清理 SQL 不改写。连接销毁即释放临时表，不回池，不写正式历史、活动或账务。

## 验证

- 当前数据库上，对修复后的原始 DELETE 做 `EXPLAIN`：成功，未执行正式数据删除。
- `node tools/ai-chat-sync-list-verify.js`：两种真实排序规则下 HTTP 200；本人两条孤立活动删除，有效活动和另一用户活动保留；`temporaryTablesOnly:true / providerCalls:0`。证据：`../../temp/ai-chat-sync-list-mysql.txt`。
- `npx jest tests/unit/aiConversationSync.test.js tests/unit/aiConversationPersistence.test.js tests/integration/aiConversationSync.test.js tests/integration/aiContract.test.js --runInBand --silent`：4 套、38 项通过。证据：`../../temp/ai-chat-sync-list-tests.txt`。
- 没有新迁移或依赖，没有更改限流/排队及调用预算。

此前同步实现及回归见 [跨设备同步变更记录](CHANGELOG_2026-11-10_AI_CHAT_DEVICE_SYNC.md)。此前替身数据库回归未覆盖不同排序规则，不能用其通过结果替代本次实库 SQL 验证。

---

## 来源：CHANGELOG_2026-11-10_AI_MAX_OUTPUT.md

# AI 最大输出调试（2026-11-10）

按用户要求，将本地 V3 聊天的单次输出上限拉到 GLM-5.3-Flash 官方最大值。

官方依据：<https://docs.bigmodel.cn/cn/guide/start/concept-param> 的 max_tokens 表明确列出 `glm-5.3-flash` 默认 65536、最大 131072；<https://docs.bigmodel.cn/cn/guide/models/vlm/glm-5.3-flash> 标注最大输出 128K。

本地 `.env` 调试值：

- `AI_V3_MAX_OUTPUT_TOKENS=131072`
- `AI_PROVIDER_TIMEOUT_MS=105000`（现有配置校验允许的最大值）
- `AI_V3_TURN_TIMEOUT_MS=300000`（现有整轮守卫允许的最大值）
- `AI_V3_MAX_USAGE_TOKENS=1000000`（现有累计 Token 校验允许的最大值）

V3 供应商调用读取新的输出配置；未配置时仍使用各模式原有默认值。大输出调用的 HTTP 响应体上限随输出预算增大，131072 tokens 对应 4 MiB。响应校验失败额外记录 finish_reason、请求 max_tokens、usage 和响应结构标记，不保存原始正文或密钥到该诊断对象。

验证：6 个相关单测文件，共 156 项通过，覆盖输出配置边界、实际传参、截断诊断、响应体容量、配置恢复和流式 UTF-8 解析。

真实供应商验证使用原失败请求第二次调用的 5 条消息和 8 个工具。审计日志对嵌套工具 schema 做了截断，直接重放因此返回 400/1210；随后按原工具名称从源码恢复完整定义再重放。测试使用该账号保存的原智谱连接，并仅在本次调用中指定日志里的 `glm-5.3-flash`，不更改保存的模型设置，不执行返回工具。

最终结果：131072 tokens / 105000 ms 的重放在约 105 秒后报 `AI_PROVIDER_TIMEOUT`，没有可用的完整模型响应。因此不能宣称最大输出上限已修复原失败。脱敏结果见 `D:/Code/live/temp/ai-max-output-20261110/provider-replay.json`。

---

## 来源：CHANGELOG_2026-11-10_AI_MODEL_LIST_CACHE.md

# 2026-11-10 模型列表缓存与限流分离

`POST /api/v1/ai/models 429 ... - 86` 对应原路由的本地 `AI_RATE_LIMIT` 回复：JSON UTF-8 长度为 86 字节。原模型列表和保存/切换接入商共用 `settingsLimits`，每人每分钟五次，且任何正在进行的设置操作也会返回 429。供应商的 429 由 `providerError` 转为 HTTP 502 / `AI_PROVIDER_RATE_LIMIT`，与这条本地 429 不同。

此前后端 `fetchProviderModels` 每次都调用供应商 `/models`。聊天组件仅保存当前页面的 `modelOptions`，连接设置变化会清空；设置弹窗没有共享的后端缓存。

现在在已完成本人连接/目标地址/Key 校验之后，按用户、规范化 API 地址、Key 指纹缓存模型列表十分钟。缓存键使用哈希，值仅包含模型名称；同一缓存键的并发读取合并为一次供应商请求。用户、地址路径或 Key 改变都会使用独立缓存，删除接入商和无效 Key 不能通过缓存绕过校验；失败不缓存，不自动重试，返回数组与存储值隔离。

模型列表读取不再占用设置变更限额。独立刷新限额仍为每人每分钟五次实际供应商请求，命中和合并读取不计次；超过刷新限额返回 `AI_MODELS_RATE_LIMIT` 及 `Retry-After`。缓存及限流容器有容量上限。服务关闭后清空缓存；进程重启后首个请求重新获取。HTTP 继续 `Cache-Control: no-store`，缓存位于后端内存而非浏览器或公共代理。

验证记录在 `temp/ai-model-list-cache-20261110/`：相关单元及 HTTP 集成测试覆盖 TTL、并发、Key/用户隔离、失败重试、删除后的校验、设置限额和刷新限额互不影响。本地 7788 的实际接口连续两次返回 200、八个模型，分别耗时 222ms 和 8ms。完整 AI/账户边界/API 回归见 `api-regression.json`。

---

## 来源：CHANGELOG_2026-11-10_AI_NATURAL_QUERY.md

# 2026-11-10 收支查询自然表达

收支查询已有完整工具证据，但固定汇总、重复明细表与逐句数字过滤会盖住模型判断，且正确的截止日期、总净结余可能被整句删除。此次将单个 `finance-monthly` 查询的已核验正文直接展示，模型正文无法提供汇总时才使用包含已发布净收支的简短备用说明；明细仍保留在数据集卡片。

提示版本为 `life-assistant-v4.22`。系统与最终化提示均要求先回答用户关心的情况，再解释关键变化，使用自然短段落；保留当前月截止说明。月度累计不得推测成某笔交易、收入来源或财务压力。仅有月度汇总时，不能由模型自行指认“那笔收入/支出”；只有已发布的同方向来源笔数为一才具有相应依据。

日期校验现在用实际查询范围证明“近 N 个月”“截至 N 日”“才过 N 天”等日历数字。日历数字不再依赖与金额或笔数偶然相等。总笔数按明确区间验证，区间结束月份不再自动被当成单月笔数；区间之后明确提到的单月笔数继续按该月校验。对混合数据集保留原有日历处理。

验证记录位于 `temp/ai-natural-query-20261110/`：

- `before-tests.json` 保留新增回归在修复前的失败。
- `ds-replay.json`：用户提供的 DS 示例正文可完整通过处理。
- `api-regression-final.json`：AI、账户边界及 API 集成回归，171 套、3989/3989 通过。
- `provider-finalization*.json`、`provider-shaped-final.json`：现有商汤供应商三次实际最终化样本，使用已批准的相同工具数据；没有重新读取业务数据或生成业务提案。
- `runtime-version.json`：本地 7788 服务读取到新版提示及一致摘要。

新增回归使用匿名合成月份和金额，同时覆盖正确正文保留，以及错误截止日、月份数量、借用区间笔数、虚构金额和未经证明的单笔收入。金额和账户等业务校验继续生效。

这次改变了收支总结的展示方式；普通明细、卡片排名、多主体查询和写入确认流程继续使用各自的处理。供应商仍有逐月复述的倾向，真实样本用于核对这次改善与证据边界，不代表所有措辞都已稳定达到相同质量。

---

## 来源：CHANGELOG_2026-11-10_AI_OPEN_CONVERSATION.md

# 2026-11-10 开放对话与会话能力授权

前端新增闲聊、分析、操作模式，默认分析。所有模式把完整数据集、上下文工具及业务动作目录提供给供应商；能力目录不含业务数据或真实映射。闲聊和分析直接使用自然文本／Markdown，不要求提案 JSON，不用账本数值集合逐句删除计算、假设和建议。操作模式继续使用可核对草稿协议，正式提交仍由用户确认。

进入聊天不再预先勾选业务域。模型可调用 `request_authorization`，直接调用尚未获准的读取能力也会在查库前暂停，HTTP／SSE 返回结构化授权请求，前端展示同意／拒绝。授权按读取、准备操作草稿及保存记忆两种能力区分，所有业务域开放，不将查询日期作为授权边界。授权通过后，以新请求继续原话；有效期内后续读取不重复询问。拒绝不会产生授权或自动重试。

有效期可选当前会话、当前会话 15 分钟／1 小时／24 小时。后端以账号、会话、供应商主机及到期时间校验，撤回立即生效，不依赖前端标记。既有 `ai_data_grant.domains` JSON 列存储多会话授权，旧数组白名单仅兼容旧客户端，无需迁移数据库结构。查询仍由固定只读 SQL 和现有净化流程处理；真实 ID／引用映射、凭据和联系方式不随能力目录外发。净化不能证明金额、日期与文本内容不会透露个人信息。

只读模式不自动读取记忆目录，不创建交易或业务草稿，不写记忆；模型要求操作时必须先请求授权并由用户切到操作模式。额度、调用次数和查询传输预算继续生效。结果、历史和审计标记当前模式，开放提示版本为 `life-assistant-open-v1`，操作授权提示为 `life-assistant-v4.22-auth-v1`。

验证记录在 `D:/Code/live/temp/ai-open-conversation-20261110/`，覆盖完整能力目录、未授权查库拦截、全域会话授权、限时失效、供应商绑定、会话隔离、撤回、只读写入拒绝、独立查询日期、自由分析正文、前端同意续接／拒绝及 HTTP／SSE 传递。

最终后端回归 176 套、4027/4027 通过；前端 177/177 通过，生产构建成功。本地 7788 服务已自动重载。这次验证使用合成数据和供应商替身，没有新增外部模型调用或修改真实业务数据。

---

## 来源：CHANGELOG_2026-11-10_AI_PROVIDER_ADAPTATION.md

# DeepSeek、GLM、商汤模型适配（2026-11-10）

按接入商域名和模型型号选择输出上限、思考参数、工具选择与结构化输出格式。本地 `AI_V3_MAX_OUTPUT_TOKENS=max`，切换模型后自动按对应上限发送，不再统一写死 128K。

| 接入商 / 模型 | 单次最大输出 tokens | 思考模式 |
| --- | ---: | --- |
| DeepSeek 官方：deepseek-flash、deepseek-v4-flash、deepseek-v4-pro | 393216 | 可切换 |
| GLM 官方：glm-5.3 / flash / flashx 系列 | 131072 | 固定开启 |
| GLM 官方：glm-4.7 / flash / flashx | 131072 | 可切换 |
| 商汤：sensenova-6.8-flash | 131072 | 固定开启 |
| 商汤：sensenova-6.8-flash-lite | 65536 | 可切换 |
| 商汤接入：deepseek-flash / deepseek-v4-flash | 384000 | 可切换 |
| 商汤接入：glm-5.3 | 131072 | 固定开启 |

GLM 旧型号另按官方参数表设置 98304、32768、16384、8192、4095、1024 等上限。未核实型号使用应用保守上限 4096，能力元数据不冒充已知模型上限。

商汤 DeepSeek 文档标注 393216，但实际网关返回 `field MaxTokens invalid, should be in [1, 384000]`；采用实测 384000 后成功。因此区分官方直连与商汤网关合同。

兼容规则：

- GLM 官方只发送文档支持的 `tool_choice:auto`；需要指定工具时收窄工具列表。DeepSeek 官方思考模式也按其自动工具选择规则处理。商汤 DeepSeek 保留其文档支持的 required 工具选择。
- 对不支持 JSON Schema 的接入商发送 JSON Object，本地业务输出仍完整校验。
- 按型号发送 `thinking` 和支持的 `reasoning_effort`；前端显示固定开启或可切换，换模型后重新读取能力。
- 商汤原生流式输出解析 `reasoning`；历史助手消息按官网建议只回传正文和工具关联信息。
- 两种传输共用参数适配。大输出响应容量随实际 tokens 上限增长，最高 8 MiB。
- `length` 等不完整响应仍拒绝；非流式诊断包含结束原因、实际 max_tokens、usage 和结构标记，便于区分截断与供应商错误。
- 后端能力接口公布实际整轮超时；前端按该预算加 10 秒接收回执，最多 310 秒，保留手动停止、超时释放和不自动重发规则。

本地调试设置：输出 `max`，单次供应商超时 105000ms，整轮超时 300000ms，累计用量上限 1000000 tokens。这些分别控制输出、等待时间和整轮用量；模型 1M 上下文不是前端通用能力，也不等于单次输出上限。

官网依据：

- [DeepSeek 模型与定价](https://api-docs.deepseek.com/quick_start/pricing)、[Chat API](https://api-docs.deepseek.com/api/create-chat-completion)、[思考模式](https://api-docs.deepseek.com/guides/thinking_mode)
- [GLM 参数表](https://docs.bigmodel.cn/cn/guide/start/concept-param)、[GLM 5.3](https://docs.bigmodel.cn/cn/guide/models/text/glm-5.3.md)、[GLM 5.3 Flash](https://docs.bigmodel.cn/cn/guide/models/vlm/glm-5.3-flash)
- [商汤 SenseNova 官方开发文档](https://platform.sensenova.cn/docs)

公开文档快照和脱敏验证报告：`D:/Code/live/temp/ai-provider-adaptation-20261110`。

验证结果：后端相关 8 个测试文件、204 项通过；前端聊天/合同/流式测试 78 项通过；前端生产构建通过。开发 API 的 nodemon 已自动重载。

保存连接的真实小 JSON 请求全部 HTTP 200、finish_reason=stop：GLM 4.7（131072，约 5.6 秒）、GLM 5.3 Flash（131072，约 3.7 秒）、商汤 6.8 Flash（131072，约 31.7 秒）、商汤接入 DeepSeek v4 Flash（384000，约 5.8 秒）。官方 DeepSeek 直连没有已保存连接，仅完成官方文档与合同测试。

上述验证只证明参数和小请求兼容；原复杂资产请求是否解决需单独复测。此前仅增大输出上限的原请求重放仍在 105 秒超时，不能将本次适配描述为该业务故障已修复。

---

## 来源：CHANGELOG_2026-11-10_AI_QUERY_SUMMARY_UNIFY.md

# 2026-11-10 财务回复固定摘要补齐

用户发现财务回复仍以“已计入支出／已计入收入／共…笔”开头。原因在 `v3Service.js` 的 `buildQueryAnswer`：除单个有金额引用的月度汇总外，查询会把服务端摘要强制放在模型正文前面，再追加明细表。

现在月度、分类、明细、每日收支、混合财务数据集和卡片消费的可用模型正文直接展示，不再强制复述总额和笔数；无金额引用但通过校验的月度说明同样保留。数据卡仍包含工具发布的合计和记录。模型正文不可用时保留事实备用回答，金额、笔数、日期、范围和归属校验继续执行。

最大收支、卡片排名和逐卡月度回答保留问题所需的已证明事实、并列及覆盖限制，移除额外全范围摘要。卡片数量保留已证明行表及部分覆盖信息。多主体查询继续按各自范围和数据构建独立事实，图表完成的捷径及模型调用预算不变。

回归记录位于 `D:/Code/live/temp/ai-query-summary-unify-20261110/`。新增匿名合成回归覆盖四类财务正文、无需复述总额的判断、混合数据集、排名和逐卡月度事实，以及虚构金额被拒绝后的备用回答。旧断言从正文强制汇总改为检查数据集仍持有原金额、笔数和记录。

验证：专项 6 套、267/267 通过；最终 AI、账户归属边界和 API 集成回归 174 套、4008/4008 通过，记录在 `api-regression-final.json`。本地 7788 后端进程启动时间晚于本次源码修改，已自动重载。此次没有调用外部模型。

---

## 来源：CHANGELOG_2026-11-10_AI_REMAINING_ACCEPTANCE_PLAN.md

# AI 剩余验收交接计划 — 2026-11-10

用户要求由另一位AI执行剩余测试、原负责人复审。本轮仅编制 [PLAN_AI_REMAINING_ACCEPTANCE.md](../../PLAN_AI_REMAINING_ACCEPTANCE.md)，没有运行测试、付费模型、DB/API或浏览器，没有修改生产源码。

计划覆盖15类业务真实隔离执行/规定拒绝、12组记忆并发与异常、最终完整源码冻结后123场自然HTTP验收。给出S0–S5顺序、并行边界、停止规则、证据规范及可复制执行提示。

只读核对明确了三个需优先验证的风险：跨进程Store校验与rename不是CAS；取消/超时可能在写I/O进行中终止请求；backup读取独立DB配置与cwd输出，仅注入proposal executor不足。风险写入计划，未在本轮冒称已复现。

`fixedAsset.create`当前不可执行，以正确预填与拒绝验证，不能记为正式创建成功；`fund.returnBatch`拼写按实际schema。计划保留原源码与失败证据，要求完整执行链冻结，不拼接混合hash通过。

交接文档经业务与记忆两条只读复核：分别说明review/execute拒绝层、正式服务加载冻结版本、冻结前依赖证据复用、共享Guard的并发试验、跨进程旧revision竞争及工具错误/HTTP状态区别。没有追加测试。

---

## 来源：CHANGELOG_2026-11-10_AI_REMAINING_ACCEPTANCE.md

# 2026-11-10 AI 剩余能力验收（P/BG、记忆并发故障、Q123 最终源码）

## 本轮生产修复

1. `api/src/modules/ai/service/memoryStore.js`：新增跨进程文件锁 `withFileLock`，把最后 revision 复核与 `rename` 放进同一把锁；`write` 接受 `signal`，rename 前检测取消。修复双 PID 同旧 revision 竞争时两方都返回 saved、后写覆盖前写的问题（MC02），并阻止取消后仍提交文件（MF02）。
2. `api/src/modules/ai/service/requestGuard.js`：取消/超时先落 `failed` 终态回执，再有界等待已调度文件 I/O settle；晚到的记忆副作用写入失败回执并追加到错误信息，避免 OCR 断连回执长时间停留在 `running`，同时如实披露已提交写入（MF03/MF04）。
3. `api/src/modules/ai/service/v3Service.js`：`memory_write` 把 `budget.signal` 传入 Store，使文件提交前可响应取消。

以上仅 3 个 AI 源文件变化；无业务模型、SQL schema、提示词或护栏放宽。原 sourceDigest `c4bd1985…` → 最终 `fe071a65ef0fc128cc6180fda13f193ebb81636f3c7f564bffe6c1e473c49a43`。

## 验收结果

- P01–P15：真实商汤同 kind 正向 + 隔离库真实事务/回读/重放；P09 单列 `EXPECTED_REJECTION`。P01/P02/P03/P04/P05/P06/P07/P08/P10/P11/P12/P13/P14/P15 全部通过。
- BG01–BG08 与 P01/P02/P03/P06/P07/P08/P10/P12/P13/P14/P15 反例：37 项全部通过，含事务回滚、并发双执行、过期/取消、越权、容量、精度、虚拟卡、永久删除与备份忙碌。
- 记忆：Store/Guard 12 组通过；MC02 双 PID 修复后恰一 saved、一 `AI_MEMORY_CONFLICT`；取消/超时先落终态再等 I/O settle，已提交副作用可见。
- Q123：冻结源码后自然 7788 HTTP 跑 123 场，122/123 最新通过；H23 保留 runner failed，正文明确“当前清单不能证明当时清单”，按合法否定语义接受。133 次尝试、302 次商汤调用、2,925,391 prompt / 71,477 completion tokens。
- 回执/历史：133 请求双读、66 聊天恢复，0 新模型调用、0 新增 provider 记录。
- 完整 API 回归：192 套 / 4315 项全部通过，绑定最终源码清单。
- 正式数据：21 张共同业务表 before/after 完全一致；正式 memory hash 不变（`921f0f2d…`）；backup 真实 dump 源库为隔离库 `aiacc_20261110_1257`，输出在 temp，未引用 `live_dev`。

## 未完成/保留

- ME03：工具 `textTruncated` 反馈正确，但真实模型最终正文把首行 307 字符误报为 400/207；两次请求均复现，原失败保留，未改断言掩盖。
- MC03 HTTP 对照：实际 7788 为开发配置 `maxConcurrent=10`，第二请求未被 `AI_RATE_LIMIT` 拒绝；隔离 Guard 以生产等价 `maxConcurrent=1` 验证通过。未修改正式配置。
- P15 异步失败真实披露、ME02 中文 regex 成功未执行。

证据目录：`temp/ai-remaining-acceptance-20261110-125717/`，入口 `REVIEW_REQUEST.md`、`review_bundle.json`。

---

## 来源：CHANGELOG_2026-11-10_AI_REQUEST_ADMISSION.md

# AI 请求接纳策略调整（2026-11-10）

用户报告 `/api/v1/ai/v3/chat/stream` 在 22ms 内返回 `429 AI_RATE_LIMIT`，随后明确要求调整策略，不全面移除保护。原 DB 护栏把同用户并发和分钟频率合并为一个错误；默认并发 1、生产窗口 6 次/分钟，临时拒绝还会写入失败请求墓碑。

- 保留同用户默认并发 1、跨进程 SQL 接纳锁、持久去重、每日配额、单轮模型/工具预算与取消保护。
- 各环境默认窗口改为 30 次/分钟，已有 `AI_RATE_LIMIT_MAX`、`AI_RATE_LIMIT_WINDOW_MS`、`AI_MAX_CONCURRENT_REQUESTS` 覆盖仍有效。
- 并发竞争先等待空位：默认最多 30 秒，每进程/用户最多 8 个等待请求，支持 `AI_REQUEST_QUEUE_WAIT_MS`（0 可关闭等待）、`AI_REQUEST_QUEUE_MAX`。等待容量在共享 executor 的 Guard 实例间共享；跨进程执行并发仍由 DB 检查。等待者不持有事务连接，不调用模型、不计请求次数，不写执行回执。
- 等待超时/容量耗尽返回 `503 AI_REQUEST_BUSY`；窗口耗尽保留 `429 AI_RATE_LIMIT`。响应携带等待秒数；SSE 已开始时用错误帧传递，避免修改已发送响应头。
- 临时拒绝不消耗 requestId，允许后续手动提交；已接纳/已执行请求仍不可重复付费调用。取消等待写入零调用失败回执，不改变其他在途请求，前端停止后可确认终态。
- 接纳后开始计算处理时限；SSE `queued` 阶段显示等待提示。前端明确繁忙错误允许手动重试，不轮询不存在的回执；其他未知网络失败继续只读查询回执。
- 沿用工作区同期新增的服务端处理时限透传，补充 `requestPolicy.queueWaitMs`。前端总时限为有效处理时限 + 有效等待时限 + 10 秒回执传输时间，上限 370 秒；保持单一绝对计时器，进度事件不延长计时、不重发模型请求。

范围仅为聊天主链路和共享 DB 护栏。OCR 的独立 HTTP 窗口、辅助接口频率、模型列表缓存刷新策略、每日额度、供应商限流及单轮防循环均保留。没有修改 `.env`，没有运行数据库迁移，没有调用真实供应商。等待队列是进程内短时等待，不提供持久队列或跨进程 FIFO 保证；进程退出后需要手动重新提交。

验证：

- 首轮 AI 回归：177 套 / 4063 项，4062 通过；唯一失败为旧契约测试仍要求第 7 次请求返回 429。更新为第 31 次拒绝后复测。
- 最终关联回归：7 套 / 125 项全部通过（请求护栏、参数策略、每日/单轮预算、旧契约共享护栏、V3 JSON/SSE 契约、边界与设置）。证据：`../../temp/ai-request-admission-final-jest.json`。
- 前端 AI 回归：132 项全部通过。覆盖忙等待、手动重试、超时预算、停止与未知网络异常的只读恢复。证据：`../../temp/ai-request-admission-web-tests.txt`。
- 前端生产构建通过；保留项目已有 Browserslist/包体积提示。证据：`../../temp/ai-request-admission-web-build.txt`。
- 修改文件 `git diff --check` 通过；现有 7788 的只读 `/api/health` 返回 200。开发进程由现有 nodemon 重载，不新建服务。

前次验收材料中“并发第二请求应立即返回 429”的结论属于历史策略，本记录更新当前预期：短时等待，然后执行；只有等待耗尽或真实频率超限才明确拒绝。

---

## 来源：CHANGELOG_2026-11-10_AI_REVIEW_CLOSEOUT.md

# 2026-11-10 AI 验收复审与保留问题收尾

ME03 与 MC03 已修复并实际验证；H23 历史证据、P15 异步失败、中文 regex 成功已补齐。当前 sourceDigest 为 `f4dc770093f4486da1b890edb4873bfe6027a8c8f1405d51bc31339f55b85bc4`，提示词仍为 life-assistant-v4.21。

## 变更

- `memoryTextEvidence.js` 提供 Unicode 码点分页和原始逐行证据，区分正文总长、单行长度与返回范围；最多 50 条行元数据并给出继续位置。
- `memoryStore.js`、`memoryRegexWorker.js` 的 literal/regex 搜索返回同文件 revision、原始 lineCharLength、returnedCharCount、returnedRange 与截断状态。保留前轮跨进程锁及取消写入修复。
- `memoryTools.js` 向模型说明计数、换行、分页、字节数及脱敏语义；`v3Service.js` 接入读取证据，标记脱敏改变的可见内容。
- `service/index.js` 同用户默认并发统一为 1，包含 development；已有显式配置仍生效，开发请求频率保持 30/分钟。

## 实际验证

- API 回归 193 套 / 4325 项通过，包含 Unicode、CRLF、分页半行、空行、EOF、307 字符案例及此前锁/取消测试。回归后只读源码快照与文件时间核对期间未改码，不将旧回归结果迁移到当前源码。
- ME03 真实商汤 3 次调用：答案准确为 307 字符，搜索仅返回第 1–240 字符（endExclusive=241）；读与搜同 revision，最终答案与工具上下文一致。
- 中文 regex 成功 2 次商汤调用：8 条完整原文、第 2–9 行全部准确；记忆无写入。
- MC03 现有 7788 自然 HTTP，首请求 running/provider_calls>=1 后才发送第二；第二 429 / AI_RATE_LIMIT、0 模型与工具调用；首请求正常完成，3 次商汤调用。双方终态、双读回执与审计一致。两次测试预检失败均为脚本权限/会话字段问题，0 模型调用，报告保留。
- H23 独立只读 SQL 核对原历史月份三行、五类状态及范围数量；接受原回答的合法否定，原 runner failed 不改写。
- P15 在既有隔离库真实 mysqldump 认证失败：真实后台 failed、失败披露、两读与重放、单 worker、I/O 结束及无成功 SQL 文件通过，0 模型调用。
- 正式 21 张业务表、owner fundHistory 补充范围与正式 memory 前后 hash 一致；记忆与备份故障仅写 temp/隔离库。没有新终端窗口、服务、端口或 DS 调用。

## 版本界限

旧 Q123 属于 fe071a65…，122 runner 通过及 H23 独立语义接受分别记录。本轮新源码做直接影响链，未重跑全 123，不能宣称同一最终 hash 全矩阵通过。旧 P/BG 报告缺独立运行版本绑定；8 个 SQL 动作/提案/备份依赖与旧清单字节一致只作补充证明，不能反向制造版本。P09 仍为确定性拒绝，BG 37 项不代表每一种 kind 全部组合。

入口：[复审报告](../../temp/ai-review-closeout-20261110/REVIEW_CLOSEOUT.md)、[机器汇总](../../temp/ai-review-closeout-20261110/review-closeout.json)。原始失败、REVIEW_REQUEST.md、review_bundle.json 保留。

---

## 来源：CHANGELOG_2026-11-10_AI_STAGE1_A1_FIX.md

# A1 修复关闭日记（2026-11-10）

验收报告 [REVIEW_2026-11-10_AI_STAGE1_FIX_ACCEPTANCE.md](REVIEW_2026-11-10_AI_STAGE1_FIX_ACCEPTANCE.md) 第 2 节的 A1/P2（基金候选仍 JOIN 收益历史）本轮修复关闭。原报告、原审计与前次复审材料保持不变。

## 改动（2 文件）

**生产代码** `src/modules/ai/service/businessRead.js`（现 `:575`）：fund 分支拆为两路——

- `candidateOnly`（list_choices）：直接 `SELECT f.id, f.fund_name AS name FROM fund f WHERE user_id=? AND is_deleted=0 ORDER BY f.id LIMIT 101`，不再执行 holdings 聚合，datasets 留空（与 finance 的 S4 模式一致）；
- 非 candidateOnly（query_data）：holdings 聚合 + history 数据集原样保留移入 else 分支，数据集行为零变化。

**测试** `tests/unit/aiBusinessRead.test.js`（现 `:411`）：executor 守卫与最终断言从 `sql.includes('FROM bus_fund_history')` 改为表名任意出现（堵住 `JOIN bus_fund_history` 漏网——A1 全量绿灯假阴性的根因），并补 `expect(fundResult.datasets).toEqual([])`。

## 验证（未调付费模型，真库仅隔离 live_ai_test）

| 验证 | 结果 |
|---|---|
| 定向单测（aiBusinessRead） | 35/35 通过 |
| 反证：临时还原旧行为（候选 SQL 重新 JOIN bus_fund_history）跑新断言 | 立即失败于 `AI_READ_FAILED`——与验收报告描述的失败路径一致，断言真咬合，非假绿灯 |
| 全量离线回归 | 202 套 / 4452 项全过（54.4s） |
| 隔离 MySQL 真库 S1–S5 | 5/5 通过 |
| 独立复核脚本（生产 repository + 参数校验 + 候选投影，注入 history 表 ER_TABLEACCESS_DENIED_ERROR） | 6/6：基金候选成功、`historyReads=0`，原 S4 四场景 acceptancePassed=true 不回退 |

复核脚本为「修复后」变体：断言从「复现 AI_READ_FAILED」翻转为「候选成功 + history SQL 为零」，对修复后代码 exit 0。

## 证据

`../../temp/ai-stage1-a1-fix-20261110/`：candidate-review-postfix.cjs（修复后复核脚本）、candidate-review-postfix.json（6 场景结果）、api-regression.json。

## 遗留

验收报告第 5 节清单不变：服务进程重启恢复、多进程并发、真实供应商、SSE/浏览器验收、v2 九场景迁移 V3。本轮均不受影响。

---

## 来源：CHANGELOG_2026-11-10_AI_STAGE1_AUDIT.md

# 2026-11-10 AI 接入一阶段审计

重新核对当前 api/web 的接入流程、执行编排、业务逻辑、错误处理、最终响应和只读恢复。审计完成，保留 5 项已复现问题（1 P1 / 4 P2），未修改生产实现。

- P1：已保存接入商改变模型/Key/地址时轮换连接 ID，却以新 ID 更新旧数据库行；0 行更新仍显示成功，重启恢复旧值。
- P2：busy/限流后同请求号重试，活动旧 token/终态阻止更新，跨设备状态仍显示失败。
- P2：并发配置大于 1 时每日额度读取与调用预占分离，存在竞争超额。
- P2：仅查询分类候选仍先读取账户，超过 100 个无关账户就拒绝。
- P2：默认 analysis 及 chat 跳过执行完成声明检查，模型虚假“已入账”可显示并写入历史。

本轮实际验证：API 179 套 / 4078 项、Web 210 项通过；Web 生产构建通过。新增 8 个有状态离线 SQL/V3 响应复现场景，确认以上问题；它们不是修复验收。没有付费供应商调用、真实数据库调用、正式业务测试写入或新增常驻服务。

新增 [审计报告](REVIEW_2026-11-10_AI_STAGE1.md)，证据位于 `../../temp/ai-stage1-audit-20261110/`。包含回归 JSON/文本、构建文本、可执行审计脚本、复现 JSON、源文件摘要与机器汇总。摘要在回归后生成，API 源码 mtime 无晚于本轮回归开始的记录；不将旧 123 场真实验收迁为当前版本完整通过。

按根目录 agent.md 要求，在 API README 新增本轮引用。区分默认 analysis 的自然响应、operate 的结构化响应和未传 mode 的严格 V3。后续先整改连接持久化与完成声明，再修同步重试、候选读取及原子额度，按影响范围复测。

---

## 来源：CHANGELOG_2026-11-10_AI_STAGE1_CONTRACT_HARDENING.md

# AI 候选契约单源化与真库 harness 加固日记（2026-11-10，追加166）

承接 A1 修复（[CHANGELOG_2026-11-10_AI_STAGE1_A1_FIX.md](CHANGELOG_2026-11-10_AI_STAGE1_A1_FIX.md)）后的架构评审：负责人确认两项定点改造方向，并给出六点修正（A1 已完成勿重做、fail-closed 表述降级、CHOICE_GROUPS 放 datasetCapabilities 保持纯数据、v3Service 拆分须先列可达状态、tablesRead 须解析表引用而非提取标识符、harness 应断言表集合而非仅数量）。本轮落地其中可直接执行的契约部分。

## 1. 候选映射单源化（消灭 7 处副本）

唯一来源：`src/modules/ai/service/datasetCapabilities.js`（纯数据注册表，保持零运行时依赖）：

- `CHOICE_GROUPS`（域→组，深冻结，复用既有 `freeze()`）；
- `CHOICE_GROUP_ENUM`（派生去重扁平枚举，顺序与原字面量逐位一致）；
- `CHOICE_DOMAINS`（组→域，由 CHOICE_GROUPS 反演派生）；
- `CHOICE_SOURCE_DOMAIN`（组→源域，candidateOnly 跨域收窄依据）；
- `CHOICE_SOURCE_DATASETS`（组→覆盖数据集，choiceCoverage 截断事实）。

清点的 7 处副本全部收敛：v3Tools 本地 CHOICE_GROUPS、其 schema 枚举、其 definitions 枚举、businessRead 的 DOMAIN_CHOICE_GROUPS 与 CHOICE_SOURCE_DOMAIN（原在 read() 闭包内逐调用重建）、queryEffectiveArgs 的扁平枚举、analysisPreviews 的 CHOICE_DOMAINS 反演表。`null` 契约（group=null → 迭代全组）原样保留。

**契约断言**（织入 `assertDatasetCapabilities`，模块加载即验）：每个 CHOICE_GROUPS 域 ⊆ 数据集域；每组有归属域；**单属组必须声明源域**（新候选组不能绕过 candidateOnly 收窄）；源域/源数据集键集全等；源数据集存在且其域=源域。读取器一侧由测试白名单承接（见 §2），SQL 与运行时读取函数不动、留在仓库层。

## 2. tablesRead 表引用白名单（测试侧 SQL 契约）

新 `tests/helpers/sqlTables.js`：

- `tablesRead(sql)` 只捕获 FROM/JOIN 目标（含子查询、限定名、反引号），剥离注释与字符串字面量；列名/别名/派生表别名不混入；**未闭合注释或字符串直接抛错**——解析失败让测试失败，不静默漏判；
- `CANDIDATE_SOURCE_TABLES`：候选组→允许表集合（cards=`bus_category`+`card_base`，银行名存 bus_category type='bank'；categories=`bus_category`；todos=`todo`；funds=`fund`；fixedAssets=`fixed_asset`）。

`aiBusinessRead.test.js` 六个 candidate 用例改按白名单逐 SQL 集合比较（`onlyCandidateTables`），替换关键词邻近匹配（`/FROM account\b/` 等）——该缺陷类即 A1 假绿灯根因。**反证**：临时注回旧缺陷（候选 SQL 重新 JOIN bus_fund_history）→ 立即失败于 `AI_READ_FAILED`（executor 守卫抓到表名），恢复后 35/35。先用于 AI 读取测试，后续按需推广。

## 3. 真库 harness 加固（表集合 + 关键列/索引 + DDL 回归）

新 `tests/real/liveSchema.js`（纯函数，无数据库依赖）：

- `findStatementEnd`/`parseCreateTables`：小型词法扫描定位语句终点——跳过单/双引号字符串（'' 转义）、反引号标识符、`--` 与 `/* */` 注释；闭合行 `) ENGINE ... COMMENT='...; ...';` 引号内分号不再截断（旧正则 `[^;]*;` 会截，live.sql 现无此形态，契约先行护住）；未闭合构造抛错；
- `EXPECTED_TABLES`：41 张表名硬断言（数量相同仍可能缺错表，按名字集合比对）；
- `CRITICAL_COLUMNS`：11 张关键表（接入商/授权/运行/审计/草稿/候选链路）关键列断言；
- `CRITICAL_INDEXES`：`uk_profile_conn`/`uk_grant_user`/`uk_fund_record_date`。

`tests/real/harness.js`：`rebuildDatabase` 弱断言 `<35` 替换为表集合比对；建库+迁移后新增 `assertCriticalSchema`（information_schema 直读）。DDL 解析回归 5 项 + tablesRead 契约 5 项进**默认离线套件**（新 `tests/unit/aiLiveSchemaDdl.test.js`、`tests/unit/aiSqlTables.test.js`，其中一项直读 mysql/live.sql 对照 EXPECTED_TABLES，表漂移在离线即可报警，不依赖真库轮）。

## 4. 验证（未调付费模型，真库仅隔离 live_ai_test）

| 验证 | 结果 |
|---|---|
| 定向：aiBusinessRead / datasetCapabilities / V3FilterReaderIntent / analysisPreviews | 197/197 |
| 新增套件（DDL 回归 + tablesRead） | 10/10 |
| 全量离线回归 | **204 套 / 4462 项全过，0 失败**（202 基线 + 2 新套件） |
| 隔离 MySQL 真库 S1–S5 | 5/5（表集合与关键列/索引硬断言在真实建库路径跑通） |

## 5. 边界与后续

- 生产 SQL/读取逻辑零改动：五个文件均为映射来源替换与枚举派生，数据集行为不变。
- **claims 词面校验定性修正**（负责人实测）：现拒绝语义只覆盖「被规则识别且缺回执」的声明面（「我已经帮你完成入账」被拒；「这笔款项已经写进账簿，余额也变了」通过）。保留拒绝语义必要，但正确性长期方向 = 结构化证据绑定 + 服务端生成可确认操作状态；规则表化只提升可审计性，不提升正确性上限。fail-closed 表述以此为准。
- **v3Service 按阶段拆分**（后续轮）：先列实际可达状态（openMode/relaxedMode 由 request.mode 派生，部分 taskContext 在 relaxedMode 禁用，不可直接相乘）；提取纯后处理函数，避免搬出后仍传巨大可变 context；授权复验、声明校验、事务提交、恢复载荷的顺序必须保持。
- 遗留清单同验收报告第 5 节：服务进程重启恢复、多进程、真实供应商、SSE/浏览器、v2 九场景迁移。

## 证据

`../../temp/ai-stage1-contract-hardening-20261110/`：api-regression.json（204 套/4462 项）、mysql-regression.json（真库 5 项）。

---

## 来源：CHANGELOG_2026-11-10_AI_STAGE1_FIX_ACCEPTANCE.md

# 2026-11-10 AI 一阶段五项修复验收

独立复核并复跑用户交付。原 S1–S5 在列明范围内验收通过，S4 的 finance 分类/账户候选读取已由 V3 传 candidateOnly 隔离。另新增 A1 / P2：基金候选仍 JOIN bus_fund_history，历史表故障会阻断候选；新增单测只检查 FROM，漏掉 JOIN。

新增[验收报告](REVIEW_2026-11-10_AI_STAGE1_FIX_ACCEPTANCE.md)和 README 最新引用。保留原审计、前次复审与各自证据，不修改生产实现或仓库测试。

独立验证：

- 默认离线 API：202 套 / 4452 项全部通过，失败 0。
- 本机 live_ai_test 真 MySQL：1 套 / 5 项全部通过，使用本地脚本供应商，付费调用 0。
- 四个原 S4 生产读取路径回放成功，account SQL 为 0；新增基金 JOIN 历史故障回放返回 AI_READ_FAILED，单独记录为 A1。
- harness 当前匹配完整 41 张表及含分号注释的 ai_chat_activity，真实建库通过。
- 旧 v2 真库文件保留为 .skip，9 场景未计入通过数量；新增五项不等于旧链路全覆盖。

新证据：`../../temp/ai-stage1-acceptance-20261110/`，含离线/真库回归 JSON 与文本、候选复核脚本与 SQL 结果、当前源码和保护材料清单、机器汇总。

S1 验证 Store 重建，S3 为同一进程并发连接，S5 为本地脚本供应商；未执行真实服务重启、多个应用进程并发、真实供应商故障或新 SSE/浏览器验收。Web 有其他已有修改，本轮未修改或测试。未写正式业务库。

---

## 来源：CHANGELOG_2026-11-10_AI_STAGE1_FIX_REVIEW.md

# 2026-11-10 AI 一阶段五项修复查收

独立复核用户交付的 settings、conversationSync、requestGuard、businessRead/candidateSelection、v3Service 修复。S1、S2、S3、S5 在源码核对与离线回归范围内可关闭；S4 部分完成，仍保留 P2：候选组过滤后继续查询流水，目标外权限故障或脏金额仍使候选请求失败。

新增[修复复审报告](REVIEW_2026-11-10_AI_STAGE1_FIX_REVIEW.md)，并同步 README 引用。本轮未修改生产实现或仓库测试，原[审计报告](REVIEW_2026-11-10_AI_STAGE1.md)、[日记](CHANGELOG_2026-11-10_AI_STAGE1_AUDIT.md)和 `../../temp/ai-stage1-audit-20261110/` 证据保持原样。

验证：

- 独立 API 针对性回归 10 套 / 336 项全部通过，失败 0。
- 新增 4 个生产读取路径的隔离回放，确认原 101 个无关账户问题已消除，同时复现候选仍访问 account 流水、权限错误 `AI_READ_FAILED` 及脏金额 `AI_READ_INVALID_AMOUNT`。回放的 `acceptancePassed:false` 表示 S4 未验收通过。
- 原 384 文件清单对比仅六个 service 与六个单元测试变化；覆盖的 Web 源码与测试未变化。
- 原审计材料 SHA256 和当前源码摘要另存于新证据目录，文档写入前后核对保护材料与源码。

新证据目录：`../../temp/ai-stage1-review-20261110/`，包含 targeted-regression JSON/文本、候选隔离复现脚本/JSON、源码与原材料清单、机器汇总。

用户报告的全量 API 202 套 / 4450 项通过单列为交付声明，本轮未独立重跑全量。未调用付费模型、访问真实数据库、写正式业务库或启动服务；Web 未修改、未测试。

---

## 来源：CHANGELOG_2026-11-10_AI_STAGE1_PROCESS_ACCEPTANCE.md

# AI 进程级验收 + 真实供应商 + 浏览器实测日记（2026-11-10，追加167）

承接[追加166](CHANGELOG_2026-11-10_AI_STAGE1_CONTRACT_HARDENING.md)后的遗留验收清单。负责人指令：批次执行进程级验收、真实供应商直接用 qwen 配置、浏览器直接开测。三批全部完成。

## 批次1：进程级验收（真库，本地脚本供应商）

新 `tests/real/aiStage1Processes.realtest.js` + 子进程 worker `tests/real/aiProcessesWorker.cjs`（fork，真实 OS 进程边界，共享隔离库 live_ai_test + 同一本地脚本 provider）：

- **S3 跨进程日额度**：两个子进程各自起真 Express+真 service，同时放行并发请求（`AI_V3_DAILY_PROVIDER_CALLS=1`）→ 恰好 1 次 200 + 1 次 `AI_DAILY_CALL_LIMIT`，`ai_request_run` 合计 `provider_calls=1`；审计层恰好 1 行 status=ok + 1 行 error(AI_DAILY_CALL_LIMIT)（失败 attempt 也落审计行，符合追加164「含失败行」设计）。**验收报告 S3 的「尚未执行多个应用进程争抢」脚注就此关闭。**
- **S1 跨真实进程重启**：父进程落初始配置 → 独立子进程 A 按旧 connectionId 轮换模型/Key → 库中单行且 is_active=1 → 全新子进程 B（空 Store）warmup 后恢复轮换值。**「重启」从 Store 重建升级为真实进程边界，S1 脚注关闭。**
- 坑：worker 的 fork env 必须显式覆盖 `.env` 的真实 AI_BASE_URL 与额度；`mockProvider.url` 不存在（listen() resolve 返回 URL）。

## 批次2：真实供应商（qwen）

新 `tests/real/aiRealProvider.realtest.js`，**门控 `AI_REAL_PROVIDER_TEST=1`** 才运行（常规 real 套件零付费调用）。Key 不落地明文：从正式库 live_dev 只读复制激活的 qwen 密文行（`maas.qianwenaiapi.com` / `qwen3.8-flash`）到隔离库，服务经同一 `.env` 派生密钥解密直连。4/4 通过：

1. 真实非流式外发：200，审计 status=ok、model=qwen3.8-flash、usage 完整（total_tokens 7685，prompt 7654 含 cached 7168，completion 31）；
2. 真实 SSE 流式：`[status, status, done]`——**V3 流式契约=status/tool 事件流+done 终帧**，无独立 answer 事件（增量 answer 只在 v2 legacy 链，`deepseekChatStream` 仅接 businessService）；断言按真实契约修正；
3. 思考开关走 `PUT /ai/preferences` 真实链路：偏好→effectiveEnv→config.thinking 全链生效；
4. 审计汇总落 `real-provider-audit.json`。

**修复 F-1（审计缺口）**：v3 链 provider 审计行从不记录 `thinking_enabled`（v2/legacy 记、v3 盲区）——`v3Service.js` 两个 provider record() 补 `thinkingEnabled: Boolean(initial.config.thinking)`，思考状态全链可审计。修复后审计 thinking_enabled=1。

**过程坑（均已修）**：`tests/setup.js` 钉 `DB_NAME=live_test`/`JWT_SECRET=test-jwt-secret-key` → 跨库密文解不开 + 源库指错；套件内从 `.env` 恢复真实值（仅本进程）。`usage` 是 MySQL 保留字（追加164 老坑二次验证）。

**发现（非缺陷，记录现状）**：qwen 网关被归类 unknown 供应商，thinking=on 时按 `providerCapabilities.js:97` 发 `reasoning_effort=high`，网关侧有轻量推理痕迹（completion reasoning_tokens=15）；思考对 unknown 供应商的支持未列入能力表，UI 层按未支持处理——是否补录 qwen 能力卡待负责人拍板。

## 批次3：浏览器实测（真实环境 + 真实 qwen + 真实数据）

api:7788 与 web:5173 均在跑，IAB 直开 `/ai`：已登录会话即 qwen 配置账号，零配置写入。流程：

1. 连接态显示 `maas.qianwenaiapi.com`，composer 模型选择器 `qwen3.8-flash`；
2. 发送「上个月我的支出总额是多少？」→ SSE 状态条实时渲染（AI 处理原话 0.4s → AI 选择能力 4.0s → 读取必要数据 → AI 结合数据分析，多轮工具往返）；
3. **授权门控正确弹出**（该账号 live_dev `ai_data_grant` 为空）→ 追加165 紧凑弹窗 → 选「当前会话 · 24 小时」→ 同意授权 → **自动续流不重复询问**；
4. 真实回答：2026年10月支出 CNY 218.38 / 3 笔 + 明细 + **模型级诚实提醒**（「这个数字基本不能代表你10月的真实花费……更像是账单没同步或没记账」）+ 后续建议反问；
5. 数据卡横滑条渲染（收支月度趋势 1 个月 / 收支明细 3 笔，含「尚未数据」徽标语义）+「本会话已授权」提示 + 重新生成按钮。

截图：`browser-auth-dialog.png`、`browser-final-answer.png`。过程中一次「本次连接已关闭」为自动化双击竞态触发（错误卡正确给出重试/读取回执，重试后流程完整），非产品缺陷。**验收报告「SSE/浏览器验收」缺口就此关闭。** 副作用留痕：为该用户写入了一条 24 小时会话级 `ai_data_grant`（自然到期，无需清理）。

## 验证汇总

| 批次 | 结果 |
|---|---|
| 真库进程级套件（S3+S1） | 2/2 |
| 全部真库套件（S1–S5 + 进程级） | 2 套 / 7 项全过 |
| 真实供应商套件（qwen，门控） | 4/4 |
| 浏览器实测 | 全链路通过（含授权门控与续流） |
| 离线全量 | 205 套 / 4469 项中 3 项失败——全部位于并行会话在途文件（`requestGuard.js`/`conversationSync.js`，「expired process lease」新语义），与本轮改动无依赖交集；本轮范围 6 套 / 207 项全绿 |

## 遗留

- 离线那 3 项失败待并行会话收口后复跑全量确认（非本轮文件）。
- qwen 能力卡是否补录（thinkingSupported/上下文窗口/输出上限）待拍板。
- v2 九场景迁移 V3、v3Service 按阶段瘦身、claims 规则表化：维持原排期。
- 自动化双击竞态提示：浏览器验收用单次动作+确认循环，避免复数触发。

## 证据

`../../temp/ai-stage1-processes-20261110/`：mysql-regression.json（真库 7 项）、api-regression.json（离线）、real-provider-audit.json（qwen 审计行）、browser-auth-dialog.png、browser-final-answer.png。未写正式业务库业务数据；唯一写痕 = 会话级授权行（自然到期）+ 该账号本轮对话消息。
