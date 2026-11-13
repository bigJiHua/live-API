# 2026-11-12 变更记录

## AI数字证据门收尾修复

承接交接审计的真实净资产错算，chat/analysis按本轮数据与成功calculate输入/结果核验，有限纠正后只存安全正文；假设结果不能变已保存事实，工具超量计算批次零执行后安全终稿，伪工具/空正文回退真实数值。分期保存状态0计数误判和总期数冒充剩余已修。最新真实8例7/8，唯一分期错误用捕获原文和真实快照复核通过，未继续重复付费；最终离线与证据见 [专属修复日记](CHANGELOG_2026-11-12_AI_CHAT_NUMERIC_EVIDENCE.md)。

## AI交接审计与接手实施

最终状态：默认211套/4817通过、关键语法与空白检查通过；商汤同8例两轮真实质量门仍红（原始1/8与3/8，口径不同）。种子要点命中后仍暴露无calculate的净资产算错（61870→71370）、比例心算及工具参数/回执声明错误。按停止规则不把§11标完成、不开放搜索/推进生产或D；完整两轮报告与精确边界见下述专属日记。

已纠正生产迁移/grant目标与完整授权校验、live评测不能直跑生产、D备份表误用等交接陷阱；实现live独立域种子和web_search自建执行器（chat双门、脱敏、轮内2次、原子全站日额度、安全来源、不进账本证据）。修复读取已保存记忆误判写入、eval漏进默认回归与数字substring漏洞。初次最终离线211套/4810通过，隔离SQL七数据集及额度并发通过；真实模型补种域run1未通过，保留未接地算术/模型参数错误，后续对照见 [专属审计日记](CHANGELOG_2026-11-12_AI_HANDOVER_AUDIT.md)。当前未配搜索源，真源待配置；生产/D未执行。

## AI 失败回复固定在原请求位置

问题：A 失败后继续 B、C，A 的迟到失败历史或活动同步按入库 `messageId` 排序，导致错误气泡移动到 C 之后；刷新恢复本地 journal 也直接追加到末尾。

修复：前端按 `requestId` 整轮排序，用户原话和对应回复/多产物保持相邻，保留首次发送时间和现有对象身份。迟到回执只更新原轮；显式续跑吸收原轮锚点，不新增到末尾。journal 恢复使用原发送时间，只有用户半轮时补对应助手，已持久化失败不重复恢复，未存档失败保留恢复记录。

后端 V3 成功与失败均保存同一服务器请求接收时间 `sentAt`，历史输出、模型近期窗口及任务恢复采用发送时序。话题断点也采用此时序，避免旧失败晚保存穿过新话题。增量查询仍按消息 ID 分页，`lastId` 保持最大入库 ID，不因展示排序倒退。无数据库结构迁移。

验证：最终定向 **Web 258 项通过、API 18 套 / 355 项通过**，生产构建、语法与已跟踪变更空白检查通过；完整 `test:ai` 中 5 项旧 HTTP 夹具因 `/chat` 调用已移除的 `service.run()` 而失败，已用夹具独立定位，与本轮排序无关。没有访问真实数据库或调用付费模型。

证据：[Web 定向测试](../../temp/api-logs-archive/ai-failure-order-20261112-web-targeted.txt)、[API 测试](../../temp/api-logs-archive/ai-failure-order-20261112-api-tests.json)、[构建记录](../../temp/api-logs-archive/ai-failure-order-20261112-build.txt)。旧记录缺原发送时间且本地留档已失效时，只能按已有时间/编号稳定恢复，未对真实历史批量回填。

## AI 本轮意图、话题断点与历史工具事实

问题：旧卡消费图表已成功或失败后，保存“只有要求图表时才简洁输出”的偏好、询问生成图表使用的工具，仍被解析为旧卡消费查询。确定性月度正文还会覆盖记忆或能力答复。“开启新话题”只改闲聊模式，未隔离旧任务与待补交易。

修复：

- `currentTurnIntent` 统一区分实际业务原话、记忆操作、能力咨询、条件偏好、反馈与显式话题切换。排除记忆正文、示例、否定及假设中的业务/重置词；混合请求保留独立业务子句。
- 纯辅助请求不开放 `query_data/list_choices`，即使模型强行请求也在读取前拒绝。明确图表追问、卡类型追问和账户补充保持各自承接。
- 新话题在现有消息 JSON 中持久化可信、绑定请求的 `topicBoundary`。历史、任务、查询覆盖、摘要和待补意图的恢复不跨断点；旧存档有文字断点时使用有界兼容恢复。无数据库结构迁移。
- 月度查询直接完成仅适用于本轮纯查询；混合请求等待明确记忆操作的实际尝试/回执，数字校验后保留辅助回复。保存记忆后业务处理失败仍沿用原有实际记忆效果回执。
- 历史上下文新增 `historyToolsSummary`，只携带实际存档工具名、合法数据集标识和图表类型，用于解释之前的能力调用；无存档时不推断。摘要计入历史预算。

验证：最终相关回归 **30 套 / 763 项通过**，关键源文件语法检查与已跟踪变更空白检查通过。离线模型、数据库和临时记忆夹具覆盖用户原话、成功/失败旧任务、同轮新话题与查询、跨窗口重载、混合记忆与图表、旧买菜20元与本轮公交5元的金额隔离。未调用真实付费模型、未写真实账本或用户记忆。

证据：[测试结果 JSON](../../temp/api-logs-archive/ai-context-isolation-20261112-tests.json)、[测试输出](../../temp/api-logs-archive/ai-context-isolation-20261112-tests.txt)。

限制：此轮完成上下文路由与持久化隔离，未新增进程强杀后的请求运行状态联查或真实供应商连续对话验收。新保存的断点可越过正文历史窗口恢复；修复前无结构断点、且重置原话已经离开窗口的旧聊天，可通过再次明确开启新话题建立断点。


---

## 来源：CHANGELOG_2026-11-12_AI_EVAL_SET.md

# AI 黄金评测集（§5 C）实施与验收（2026-11-12）

## 范围

按 PLAN_AI_AGENT_CAPABILITIES.md §5 实施：31 条黄金用例（JSONL 数据驱动）+ offline 档（并入默认回归）+ live 档（门控真实供应商，报告分版本落档）+ 新增用例文档。

## offline 档（32 项含计数守卫，全绿）

- `tests/eval/offlineHarness.js`：脚本化 provider 驱动真实 createV3Service 全链路（不碰库/不碰供应商）；DATASETS 注册表 16 个数据集（字段名逐域对齐 FIELD_ALLOWLIST、金额 ≤4 位小数字符串、币种 CNY）；仓库查询按 scope 过滤行（对齐真实 SQL 行为）；draft 用例由 harness 从 list_choices 回执注入运行时 ref。
- 断言维度（对齐 §5.3）：工具序列（严格）/ 答案要点（scripted 答案存活时严格）/ 禁止项（严格）/ 语言规则（严格）/ 数字接地——答案金额必须出现在工具回执（始终严格，这是核心安全门）/ 草稿金额 / 闲聊零取数 / provider 轮数。
- **断言语义按 PLAN §5.2 定界**：offline 档断言「路由与证据门逻辑」——证据门可把 scripted 措辞替换为服务端 claims-safe 组合答案（门逻辑生效非失败），grounding/禁止项/语言/工具序列始终严格；措辞质量归 live 档度量。

## live 档

- `jest.eval.config.js` + `tests/eval/aiEvalLive.evaltest.js`：`AI_EVAL_LIVE=1 npm run test:ai:eval:live` 运行（默认 skip 不烧 token）；密文只读复制自 live_dev（优先 .env AI_MODEL 对应行，回退最新激活行）；JWT_SECRET 从 .env 恢复（密文解密一致）；隔离库 live_ai_test 全量重建 + 授权绑定；报告 `api/logs/REVIEW_<日期>_AI_EVAL_<model>.md` 分版本不覆盖历史。

## 评测集副产物：发现并修复一处真链路缺陷

- **v3Tools.js 通用 queryMeta 构建器丢失 cardTypes**：effectiveArgs 携带 cardTypes 而 queryMeta.filters 不含，导致 subject=cards 的 requireFreshQuery 任务在证据门永远 missing（goalDataset line41 cardTypes 比对 undefined≠task.cardTypes）→ 强制补查循环。修复=meta.filters 对齐 effectiveArgs（cardTypes 存在时下发）。offline 评测用例 card-monthly-trend 即该缺陷的复现载体。

## 实施过程中的门语义对账（记录给后续用例维护者）

1. canned 数据集**不要自带 queryMeta**：仓库 meta 会被链路采纳，其 sort/filters 与任务 querySort 不一致会让证据门误判（fin-monthly-explicit 曾因 canned sort=incomeDesc vs 任务 monthAsc 而被要求补查）；链路自建 meta 才与任务语义一致。
2. 排名断言（最高/最大/最多）：行全部返回时需答案含「已定价」字样，或 meta.rankingComplete=true——证据门语义而非措辞偏好。
3. work-salary 行日期必须全日期格式（月格式会让呈现层产出空答案）。
4. direction 参数是字符串枚举 income/expense/both，非 0/1。
5. chat 结果的草稿字段是 result.draft（顶层 amount），非 result.proposal。

## live 基线 v1（sensenova-6.8-flash × 31 用例，报告 logs/REVIEW_2026-11-11_AI_EVAL_sensenova-6.8-flash.md）

- 全链路真实可用：会话创建→会话授权（PUT /grant，providerHost 必须是 host 非 URL）→ SSE 流式→done 终帧，31/31 无一例编造数字泄漏。
- fallback 率 28/31：证据门高频把模型措辞替换为服务端 claims-safe 组合答案（安全机制生效；prompt 层降低摩擦是后续 prompt 迭代的量化目标）。
- 接地 ✗ ×4 复核为两类：种子缺口（budget/work/rules 域无业务行→模型诚实答空）与 draft 场景用户口述金额口径；工具序列 live 多为多轮补查（证据门语义，序列断言以 offline 为准）。
- 调试过程中三轮修复：会话需 POST {kind:'manual'}、授权 providerHost 须 host 形态、api 助手需自读文本解析。
- 已知边界四条写入 tests/eval/README.md（种子覆盖面/日期基准/grounding 口径/序列宽松），下一轮 live 迭代补种子对齐 offline 注册表。

## 验收

- offline 32/32 全绿并入默认全回归（全量 225 套分项见当日合并日记）。
- live 基线报告 v1 落档（31 用例分项表+答复原文+fallback 率），文件名按服务端日期 REVIEW_2026-11-11_*（跨零点运行）。
- 新增用例流程文档：tests/eval/README.md。

## 修改清单

新增：tests/eval/offlineHarness.js、tests/eval/aiEvalOffline.test.js、tests/eval/aiEvalLive.evaltest.js、tests/eval/cases/golden-cases.jsonl、tests/eval/README.md、jest.eval.config.js；修改：src/modules/ai/service/v3Tools.js（cardTypes 对齐）、package.json（test:ai:eval:live 脚本）。

## 与并行在途的隔离说明

本轮同窗口有并行会话改动 conversations.js（07:08）与部分回放/持久化测试文件；全量回归中 M02 回放与 aiMixedTaskPersistence 两用例的失败属并行在途（与本轮改动无关，已用临时还原 v3Tools 验证因果），按既有惯例不由本轮修复。


---

## 来源：CHANGELOG_2026-11-12_AI_HANDOVER_PLANS.md

# 剩余项全部立 PLAN 交接（2026-11-12）

负责人指令：额度所限，剩余项全部立成 PLAN 交由接手 AI 执行。本轮只写计划未动源码。

- **PLAN_AI_WEB_SEARCH.md**：web_search 实施计划（§7 路线落地）——AI_SEARCH_* 槽位/仅 chat 场景/egress 出域脱敏/轮内≤2 次/当日缓存/不进 claims/失败降级/预算挂 ai_config；验收含「未配置时逐字节一致」与 query 脱敏反证。
- **PLAN_AI_PROACTIVE.md**：D 主动智能专属计划（§6 要求的立项 PLAN）——洞察卡拉模式三期（一期惰性生成链路+claims 门+落 ai_background_job，二期 cron 兜底，三期前端卡）；§2 形态确认单五项待负责人勾选后方可动工。
- **PLAN_AI_PROD_ROLLOUT.md**：生产暗发布四步操作手册——步骤0 建号（唯一人工步骤）→ 步骤1 建表+授权（tools/ai-business-read-grants.js 18 表白名单精确匹配红线）→ 步骤2 关闸部署冒烟 → 步骤3 开闸灰度（用户自配 Key）→ 步骤4 回退预案（AI_MODE 总闸）。
- **PLAN_AI_AGENT_CAPABILITIES.md §11**：live 评测种子补齐（小项，建议最先跑）——budget/todo/work/fund/installment/asset 域种子对齐 offline 注册表，基线 v1 中这些域的「诚实答空」翻为可比数字。
- 总计划顶部状态行已更新为交接索引（四份计划+建议顺序：§11 → web_search → 暗发布（并行等建号）→ D 一期）。
- 落档：三份新 PLAN + 总计划 §11 + 三处记忆同步。

---

## 三年单用户 Mock 数据库（2026-11-12）

- 用户选择：单个用户的真实生活数据，全模块、连续三年、金额和关联一致。
- 新建本机独立 MySQL 库 `live_mock_20261112`，覆盖上海时间 2023-11-12—2026-11-12，含首尾 1097 天；42 张业务/系统表共 13858 行，另有 19 条 `_migrations` 记录。
- 新增 `tools/mock-database.js`、`tools/mock/{context,identity,finance,lifestyle,ai,validate}.js`、工具 README 和 `tests/unit/mockDatabase.test.js`；package.json 增加导出/建库、校验、独立 API 启动入口。
- 生成数据包含每日账务、快照和基金收益；信用卡/共享池、账单与还款、转账、外币、分期、预算、日记、待办、工作工资、附件以及标注为合成的 AI 历史。
- 当前业务实际语义优先：基金历史为收益/增持 delta；自动快照为现金类资产口径；工资为工作日等额税后简化规则，按月末到账。期初基金和固定资产视为已持有。
- 完整新库建表时发现并在 mock 工具内处理 SQL COMMENT 分号截断及历史005缩窄 bus_recurring.account_id。补齐008 password_changed_at，不修改现有生产初始化代码。
- 导入数据全事务；两次失败均无业务行入库，在本轮新建且业务表全空的目标库中补齐后完成。最终真库回读通过451804项字段/金额/关联/日期校验；当前CreditCore.aggregate总债7274.67与末日快照一致。
- 生成器定向测试6/6，账号密码与PIN的bcrypt真库回读核验通过。固定日期与seed可逐字复现记录和SQL；verify从manifest恢复原日期与seed。
- 原业务库与原.env未切换；新附件为独立mock目录。AI演示供应商禁用、授权撤销、后台任务终态、无真实模型调用。
- 数据包：`D:/Code/live/temp/mock-databases/live_mock_20261112/`（SQL、JSON、清单、独立环境配置、占位图片和README）。账号mock_life；登录信息见该目录README。

### Mock库测试切换与AI配置迁移（用户追加要求）

- 用户明确要求AI会话不mock、清空会话、保留迁移Key/API配置，并将当前API连接指向新mock库供测试。
- 清空目标库16张AI域表的演示记录后，仅迁入原live_dev账号的5个ai_provider_profile、1条旧版ai_provider_setting及1条思考偏好；原站点ai_config为空；会话授权不迁移旧会话引用。
- 对接入商API地址、模型、connection_id、生效标记、加密Key和fingerprint逐项核验一致；保留原API加密密钥，没有明文Key输出或写入新导出文件。
- 原.env仅更改DB_NAME/AI_DB_NAME为live_mock_20261112及INIT_ENABLE=false、INIT_SKIP=true，端口保持7788；复用原SELECT-only账号为新库18张业务表授只读权限。原库内容保留。
- API重启后真实HTTP测试通过：mock_life密码登录、PIN、4975条有效账务、5个接入商hasKey/configured=true、会话0条；没有供应商调用。
- 生成器默认AI历史为空，可复用业务模拟记录13038条。当前库另有真实接入商配置及测试登录/安全审计记录。SQL/JSON数据包已刷新为空AI历史，真实Key不导出。
- 本次连接切换前字段、迁移统计、HTTP证据放temp/api-logs-archive/mock-database-20261112；一次性处理脚本放temp/api-tools-oneoff，不放api/tools。
- 测试账号mock_life，密码MockLive2026!，PIN246810；Web仍为localhost:5173，刷新并重新登录可测当前新库。
- 追加收尾验证：生成器7/7测试通过；当前连接同库的只读verify已修正，431308项真库检查通过。当前13047行（包含7条迁入AI配置及2条接口登录/PIN审计），会话/消息/草稿/提案/调用等历史仍全0。manifest统计与导出校验和同步完成。

---

## AI Markdown 正文数值图纠偏（2026-11-12，已完成本轮实现与验收）

用户澄清：AI Markdown 答复中混排的模型生成图表需要自动解析，不能只交付取数后的业务数据卡。追加172原实现把 Mermaid 限于七种结构图，并在提示词与前端拒绝 `xychart-beta` / `pie`；旧浏览器 D1 验证的是 ECharts 业务卡，D3 验证的是拒绝正文数据图，因此旧验收没有覆盖当前正文数值图需求。

本轮修改：

- `web/src/utils/aiMermaid.js` 支持 `xychart(-beta)` / `pie` 与七种结构图；裸 xychart 归一到 Mermaid 10.9.3 语法，移除 `%%{...}%%` 配置指令，渲染器自行拒绝不支持图型。成功 SVG 缓存，失败保留回退及再次尝试能力。
- `AiMermaid.vue` 渲染正文数值图并标注“AI 正文图表”，核对异步渲染版本与 active 状态；未完成轮次、语法错误及不支持图型保留原代码。正文图表与同一消息中的业务 AiChart / 数据论据独立并存。
- `openConversation.js`、`v3Prompt.js`、`v3Tools.js` 更新图表说明，提示词版本 **life-assistant-v4.26**。正文图可使用本轮取数、用户提供或假设示例，要求说明来源；业务 chart 仍引用真实数据集、标题服务端重建并 fail-closed 校验，open 模式保持纯文本 finalize。
- 沿用 `mermaid@10.9.3`、应用 strict 配置与 `sanitizeMermaidSvg` 消毒，不扩展主富文本白名单。

当前验证：

- 定向 web **41/41**：`aiMermaid.test.mjs`、`aiAssistantUi.test.mjs`、`aiMarkdownCharts.test.mjs`。独立数值图测试直接使用真实 Mermaid 10.9.3 renderer、SVG 消毒与真实 AiMermaid SFC，覆盖中文标签、3根柱、1条折线、pie两区块与原数值图例、裸xychart兼容、pending→done、历史重新挂载、错误回退和配置指令隔离。jsdom只补确定SVG文本测量，不能作为浏览器布局证据。
- API 定向 **174/174**（aiOpenConversation 55/55、aiV3Service 119/119），覆盖 chat/analysis 正文数值图保留、存档与恢复回执、同消息业务 chart 并存，业务数据引用不变。
- 当前7788 API真实模型只接收示例值A=10/B=20/C=30，一次返回柱状、折线、饼图三个完整 Mermaid 围栏；没有工具调用或业务取数，顶层chart为null。运行时提示词为life-assistant-v4.26；原答复和摘要见 `temp/api-logs-archive/ai-markdown-charts-20261112/{answer,live-summary}.json`。
- 浏览器使用实际AssistantMessage组件加载上述真实模型原答复：350px页面中3张正文图均为SVG，文字/坐标/3个饼图区块完整，另一个示例消息中正文图与业务ECharts canvas并存。生成中→完成、reload重新解析通过，scrollWidth=350。该验收为独立组件页面，未作为登录聊天页全流程或真实历史页面恢复证据；历史存档/回执由API定向测试验证。截图 `browser-350-full.png` / `browser-350-live.png` 在上述证据目录。
- 手机可读性补齐：xychart使用460×300画布与较大坐标字体、清晰蓝色折线；SVG图形区固定白底，正文围栏间纯空行不产生空白消息卡。
- web生产构建成功，相关测试总计 **215/215**。全量web **322/327**（5败均在aiContract.test.mjs）；全量API **4674/4681**（7败涉及aiV3IsoMonthRowsIntegration、aiV3MemoryReadStateReplay、aiMixedTaskPersistence、aiOcrPersistence、aiRecentMonthScope）。这些失败所在实现不在本轮源码修改范围，未将全量基线写成通过；详见 `temp/api-logs-archive/ai-markdown-charts-{web,api}-tests-20261112.log`。
- 本轮只完成web构建，未部署线上或打包APP；浏览器临时验收页与回复JSON已从web目录移除。

文档：根 PLAN 顶部状态与§9、contract.md §8、api和web三个README已同步当前边界；旧花名日记加历史/superseded说明。本轮结果仅追加到本日合并变更日志，未新增轮号。

### AI大范围数据能力封装（用户授权实施）

- 保留十年以内完整请求日期，移除v3Tools与queryEvidenceGate的一年缩窗；‘近三年，截至今天’及跨年月份先解析完整区间，不被‘今天’缩成单日。
- 新增largeQuery：受控auto/detail/month/year规划与15分钟签名游标；绑定用户、数据集、原/实际日期、筛选、方向、排序、卡类型与粒度。偏移上限100000、单页50；无可证明数量时不造续页。
- 财务SQL全范围SUM/COUNT与金额排序不受展示页影响。通用历史支持工资、基金、预算、待办、还款、卡消费月/年聚合；资产历史按期间取最后保存快照，禁止跨日期SUM存量。
- 新增queryWindow，在16KiB预算前调小必要展示窗口，保留摘要与日期，并按实际披露行重签游标；不足完整覆盖时不保留虚假排名/完整摘要说法。
- queryMeta和历史覆盖保留resolution/page；‘下一页’承接已核验旧范围与凭据；查询缓存身份包含原请求范围、粒度及游标。新增V3真实编排回放覆盖两页与月/年两个不同结果，旧明细不再误用缓存。
- 模型原生schema和提示词描述聚合/续查能力；保留既有授权、只读、5模型/8工具、16/64KiB预算。基金完整范围收益/增持摘要进入最终答复并保留4位精度，不将组合总额归给单只基金。
- Web严格DTO、卡系列图与展示单位适配月/年/分组及分页，年度卡消费按年份对齐；测试旧/chat仅显式legacy fixture，不恢复生产旧入口。
- 真库验证仅使用live_mock_20261112的现有AI只读账号，未调用模型或写业务库：三年4577条有效统计流水，收入614897.39、支出292388.17；收支37月，工资784源、基金3291源、快照1097源，其他历史亦完整。两页无重复，摘要相同；独立SQL SUM/MAX校验相符，最大通用查询469ms。
- 回归发现旧范围断言及两套会话/OCR模拟SQL夹具滞后，更新测试契约而不恢复旧生产接口。另最小修复读取既有记忆被误判写入的边界，M02保持原3次调用断言；保留并行任务已有意图和正文图表变更。
- 证据与一次性脚本分别放temp/api-logs-archive/large-query-20261112、temp/api-tools-oneoff。完整收尾回归结果见后续追加。

- 最终收尾：API 211套/4817项全部通过，Web完整353项全部通过；包含新增聚合、分页签名、范围完整性、同轮第二页和跨粒度V3回放、基金金额文字、前端年/月/分组单位及图表验证。
- 真库→模型包装额外验收：三年月度37行完整，最终工具包6518B；默认明细50行9976B，续页offset50；8KiB窗口压成39行后续页offset39，无丢行/重复，完整SUM与4577原始笔数保持。preview的插入/审批仅本地内存模拟，真实AI表未写，无付费模型调用。
- 当前运行API端口7788，PID19952启动时间2026-11-12T05:51:49Z，在最新AI服务源码修改之后，已加载新能力。API仍指向用户指定的live_mock_20261112；不清空用户新增会话或测试记录。
- 证据索引：temp/api-logs-archive/large-query-20261112/final-ai.json、web-tests-final.txt、generic-reader-real.json、finance-reader.json、finance-provider-envelope.json、source-sha256.json。

### AI实时思考状态与结果渐进UX（用户授权实施）

- 根因：provider reasoning增量仅进私有缓冲，整轮事务成功后发布核验全文，紧接done；前端只在thinking文本非空时显示区域，并一次性安装完整answer，导致同帧出现。
- 新增thinkingLifecycle，以reasoning_status发布started/working/completed、requestId、round、elapsedMs、observed，不外发推理或未核验content；每轮状态节流，首次正文增量结束思考阶段，重复结束不重发。原reasoning全文仍保留终态核验。
- 前端提前创建思考状态区，耗时实时显示且跨轮累计；原展开偏好保持，取消/失败显示中断，旧帧/旧会话不覆盖新状态；最后非思考格式化轮不抹掉此前真实思考标记。
- 新增useReplyReveal显示缓冲：新回复从上到下展开，40ms步进、最长6秒，Unicode字素安全，可立即显示全部；历史/减少动态效果直接全文。canonical正文、复制、存档、回执、请求锁不延迟。
- Mermaid/图表/附属卡在正文适当完成后显示；重复done和同步同文不重播，修正/取消/重试/隐藏/离页清理计时器。reveal事件带原requestId，旧completion不能释放新展示状态。
- viewport小步跟随实际高度增长，用户向上滚动即停止；‘立即显示全部’不触发已排队的末尾跳转。读屏log在展示阶段静音，完成后只发布一次结束公告。
- 后端3套37项思考/SSE定向通过；后端完整215套4933项、Web完整397项全通过；16项buffer及29项真实SFC UI通过。
- 实际浏览器观察本地隔离预览（使用真实AssistantMessage组件）：思考先出现，随后文字从仅标题开始逐步增长，最后完整正文与复制按钮正常；预览不访问数据库或供应商，验收后停止临时服务。
- 本轮未清空用户AI会话或测试记录，未调用真实供应商。API:7788已自动重载最新v3Service；Web:5173开发服务继续运行。日志证据：temp/api-logs-archive/thinking-ux-api-final.json、thinking-ux-web-final.txt、thinking-stream-contract.json、thinking-ux-web-build.txt；一次性预览脚本在temp/api-tools-oneoff。
- 构建收尾：Web生产构建通过（含PWA生成），既有大chunk提示仍存在。新增显示逻辑没有额外运行时依赖。

### 实时思考正文流（用户澄清：需要看到它在想什么）

- 上轮只提前显示状态与耗时，思考全文仍到终态才核验发布；用户本轮明确要求正文思考实时可见，已接通provider reasoning_content增量→liveReasoning累计脱敏→reasoning_delta SSE→前端默认展开文本。
- 新事件携带requestId、round、sequence、mode=snapshot、provisional=true、text；120ms节流，provider暂停时timer刷新已收内容，首个正文增量flush末段。原content不经思考通道泄漏。
- 先按累计文本净化，再暂存未结束ASCII标识片段，避免API Key/email/内部ID跨chunk前缀露出；单轮12000、整轮24000字符预算与原verifiedReasoning上限并存。取消/失败/结束清理timer，晚到帧不复活。
- 前端按轮次sequence覆盖快照，默认展开真实思考并标注‘尚未最终核验’，不是只有计时。思考内滚区跟随追加，向上阅读暂停；用户手动收起保持。最终verified文本替换对应轮次，成功清未核验临时内容，临时思考不入journal/历史。
- 停止与错误保留已见中断过程但不标成功；新请求/重试/跨会话严格身份隔离。原结果渐进显示、完整复制与业务回执逻辑保留。
- 后端完整216套4960项全过；前端414项全过，生产构建通过。新增实时思考17项含provider Promise未完成时已发文本、split secret脱敏、节流暂停flush与取消timer；实际SFC展开/状态/用户偏好检查通过。
- 实际浏览器隔离预览使用真实AssistantMessage：在最终回复到达前看见默认展开的思考正文与待核验标记。预览未调用真实模型或数据库，验收后关闭临时服务；未清用户测试聊天。
- 证据：temp/api-logs-archive/live-reasoning-api-final.json、live-reasoning-api-final.txt、live-reasoning-web-final.txt、live-reasoning-web-build.txt、live-reasoning-stream-final.json。API:7788自动重载新实现，Web:5173可刷新测试。

### 待补记账任务绑定、账户点选及过期恢复（用户授权加强）

- 待补记忆增加稳定 taskId/revision，最新任务可读取安全摘要；过期可展示但不能自动执行，旧 TTL 兼容逻辑保留。历史及实时回复均提供 pendingTask，原文/evidence不进入摘要。
- 新增 GET /v3/transaction/pending 与 POST /v3/transaction/pending/resume。恢复只接受会话、任务、版本、成员下标；在会话锁下读取最新来源并重新核验，客户端不能提供金额/日期作为恢复来源。
- 前端待补卡展示原金额和日期，点击后接入现有账户/分类/支付方式表单，本地核验成稿不调用模型。多笔按成员处理；失败后只读读取待补状态，不自动恢复或重发模型请求。
- 显式恢复复用同一候选身份，候选过期后由有效任务来源恢复；取消不能复活，已消费返回原草稿。任务版本变化清除旧账户选择，原金额、方向、币种及日期在服务端保护。
- 本地成稿使用会话→候选锁顺序，事务内复验任务状态和版本；全部成员处理后写任务结束标记。原草稿确认入账、金额证据、资金核验及历史动作守卫保留，无新增迁移。
- 验证按本次范围执行：待补状态/持久化2套36项；恢复、候选、候选回执、V3服务4套146项；财务workflow22项；另1项完整createAiService链路覆盖过期恢复→招商借记卡选择→预检→本地成稿→结束任务→重复读取原草稿，模型及公共库调用均为0。未运行完整AI回归或付费供应商验收。
- 前端定向3项通过：多笔首笔完成后次笔仍可补、跨会话晚到响应隔离、真实SFC的金额日期展示/显式恢复/候选过期按钮/来源字段锁定。Web生产构建及PWA生成通过；仅既有大chunk和Browserslist提示。

---

## 来源：CHANGELOG_2026-11-12_WEB_SEARCH_FRONTEND_LABEL.md

# web_search 前端对接补遗（2026-11-12）

负责人指出 web_search 前端未对接。核实结论：引用链接渲染管线已完备（aiMarkdown→sanitizeHtml 白名单含 a/href，DOMPurify 协议安全+target 自动补 noopener），**真正的缺口是活动行标签表缺失两个新工具**——`TOOL_LABELS` 只有 8 个旧工具，未知工具活动事件被静默丢弃（useAssistantActivities.js:68-69），联网期间用户看不到任何活动提示；calculate 同样缺失（A 轮 API 侧实施时的遗留）。

修复：TOOL_LABELS 补 `calculate: '确定性计算'` 与 `web_search: '联网搜索'`。web test:ai 417/417 全绿。PLAN_AI_WEB_SEARCH.md 改动清单补 web/src 条目（原计划缺项，责任在编制）。

---

## 追加（2026-11-12）：web_search 用户级联网开关立项（负责人决议）

负责人指出联网搜索收费、必须有用户开关。已立为 PLAN_AI_WEB_SEARCH.md §3b **必做项+开闸前置**：ai_user_preference 加列 web_search_enabled（DEFAULT 0，存量默认关）→ preferences store/providerEnv 注入 AI_WEB_SEARCH_ENABLED 槽位 → config.searchEnabled 派生 → 三重门（站点配置/用户开关/chat 场景）→ PUT /preferences 扩展 + capabilities.webSearchAvailable → composer 思考开关旁加「联网」开关（webSearchAvailable=false 不渲染）。验收追加：默认关=逐字节一致；双开才可用且预算仍限。前端活动行标签（calculate/web_search）已先行修复（见上节），web test:ai 417/417 绿。
---
### 追加（2026-11-12）：联网开关 UI 定样与独立 key 答复

负责人给 DeepSeek 截图定样并三项决议：① composer 胶囊开关（深度思考+联网并排、图标+文字、选中描边；图标用 van-icon 现有集合 search）；② 设置抽屉必须加联网行且**红字常显**「联网搜索功能收费，具体参照供应商；一般而言该项为单独收费功能。」；③ 确认搜索为独立 key（AI_SEARCH_API_KEY 与聊天 Key 分离，独立计费，站点级 env 配置；用户开关只控制触发权，「用户自带搜索 Key」记为后续可选扩展）。以上全部写入 PLAN_AI_WEB_SEARCH.md §3b（UI 规格 3 条+改动清单 2 条+验收 2 条）。

---

### 追加（2026-11-12）：web_search 统一 key 事实核查（负责人指出）

负责人指出 GLM 是统一 key。查证两家官方文档证实：**DeepSeek 与智谱的搜索均使用与聊天同一把平台 key**（DS 文档示例直接用 DEEPSEEK_API_KEY 打 api.deepseek.com/v1/tools/search；智谱 zai-sdk 用平台 key 调 open.bigmodel.cn/api/paas/v4/web_search，MCP 也是 Authorization=平台 key）——此前「AI_SEARCH_API_KEY 与聊天 Key 完全分离」的表述**有误，已更正**。计费独立分项：DS ¥5/千次成功；智谱按引擎 search_std 0.01/search_pro 0.03/sogou·quark 0.05 每次单独充值（Coding Plan 不抵扣）。设计改为 **key 派生优先**：聊天供应商为 deepseek/glm 时复用聊天连接 key+base（费用天然落用户自己账户，零新配置），商汤聊天才需站点显式 AI_SEARCH_*；专用适配器只做 DS/GLM 两家（负责人定调）。智谱四档引擎定价与 query≤70、DS query≤128/结果字段表已写入 PLAN_AI_WEB_SEARCH.md。已实现 webSearchClient 需按派生设计改造（改动清单已加）。

---

### 追加（2026-11-13）：设置弹窗联网行 DOM 嵌套事故修复（负责人截图怒斥）

联网行+红字插入 AiSessionSettingsDialog 时只替换了 van-switch 行、未接管 thinking-line 的闭合标签 → web 行与红字嵌进 flex 行内部 → 整区压成竖列窄条（负责人截图）。修复=DOM 结构重排（thinking-line 正确闭合，web 行/红字为兄弟节点，红字补内边距）。web test:ai 417/417 绿。**教训：模板内插入片段必须先读完整闭合结构，禁止只替换内部元素行；插入后用结构 grep 自检开合配对。**

---

### 追加（2026-11-13）：web_search 授权响应契约修复（负责人实测「会话授权不符合协议」）

负责人实测：联网授权卡同意后报「会话授权不符合协议」。根因=validateAiGrant 契约 access 枚举无 web_search 且响应缺 lifetime。双向修复：后端 put() web_search 分支响应补 lifetime；present() 对 web-only 会话派生 access='web_search'（access 恒为字符串）；requireCoverage 数据门拒绝 access='web_search'（联网会话不得读数据）。前端 validateAiGrant access 枚举 +web_search。api 5029/5029、web 417/417 复绿。

---

### 追加（2026-11-13）：web_search 授权响应缺顶层 expiresAt 的二段修复

首轮修复（access 枚举+lifetime）后负责人实测依旧「会话授权不符合协议」——根因二段：web_search 授权响应**无顶层 expiresAt**（undefined ≠ null 且非安全整数）被 validateAiGrant 拒绝。修复：put() web_search 响应与 present() 会话形态均补顶层 expiresAt（web-only 会话取 webSearch.expiresAt）。web 新增 aiWebSearchGrantContract.test.mjs 3 项（24h/当前会话/缺字段仍拒）并入 test:ai；api 5099/5099、web 420/420 绿。

---

### 追加（2026-11-13）：live_mock 搜索预算列缺失修复（负责人实测定位）

负责人实测「联网搜索一下英伟达」：授权卡正常弹出并批准，但模型回答「我没有联网搜索能力」。日志取证：工具确已下发（request_payload 含 web_search）且授权行存在，但 phase=web_search 零记录 + 预算预占必败 → **live_mock.ai_config 缺搜索三列**（接手 AI 的 ai-search-migrate 未对该库执行，其日记已声明但交接时未列为阻塞）。已 ALTER 补齐三列 + 预占冒烟通过（占位清零）。同窗口发现接手 AI 在途的 profileGeneration refresh 每轮 AI_PROFILE_TIMEOUT 刷错误（画像整理超时 504），与本轮无关但已记录提醒。**教训：新依赖列的迁移必须在功能联调前对该库执行，交接清单要标「阻塞联调」级。**

---

### 追加（2026-11-13）：web_search 授权响应缺 providerHost 的三段修复（负责人实测）

负责人重启 API 后仍报「授权白名单不符合协议」并贴出实际响应——`providerHost` 字段**缺失**（web_search 分支手工构造响应时漏了它；validateAiGrant 的 granted 分支要求 providerHost/grantedAt/domains 三件套）。修复=响应补 providerHost；aiWebSearchGate PUT 用例断言响应形状（granted/access/providerHost/lifetime/expiresAt）。api 5111/5111 全绿。**教训：新增响应分支时必须对照前端契约逐字段核对（providerHost/grantedAt/domains 三件套是授权响应的硬字段），不能只想起自己关心的字段。**

---

## 来源：CHANGELOG_2026-11-12_AI_CHART_MERMAID.md

# 变更日记 — AI 画图全模式 + Mermaid 结构图（2026-11-12，追加172）

> **历史记录 / superseded（2026-11-12）**：本日记记载追加172原实现及旧验收，原“正文 xychart/pie 禁止”已被用户本轮要求覆盖。旧 D1 仅验证业务 ECharts 卡，旧 D3 验证拒绝正文数值图，不能作为当前正文图表需求的完成证据。当前边界与真实验证见 [当日合并变更记录](CHANGELOG_2026-11-12.md)、[PLAN §9](../../PLAN_AI_CHART_ALL_MODES_MERMAID.md)及 [contract §8](../../Docs/docs/ai/contract.md)。本轮不继续向花名日记追加实施结果。

## 问题与真实日志

负责人报：闲聊/分析模式让 AI 画图，得到 Mermaid `xychart-beta` 代码块且界面渲染不出来（显示为代码）。会话内诊断 + 浏览器验收（IAB 350px 视口，Qwen 接入商 + deepseek-v4.1-flash-1017）全程留痕：

1. **根因一（api）**：闲聊措辞「能不能给我画个图」被 taskContext 判为 `mode:'chat'` 但携带 `chartRequest`（taskContext.js:100-103 的 mode 判定与 UI 模式无关），而 `wantsChart` 公式要求 `task.mode === 'query'`（v3Service.js 原:1022）→ open 模式 wantsChart 恒 false → chart 恒 null → 模型被逼即兴写 Mermaid。服务端 chart 派生链与 `validateChart` 本来就全模式运行，只差这个门控。
2. **根因二（web）**：前端 markdown 管道（marked→DOMPurify→v-html）无 mermaid 支持，全仓 0 处 mermaid 引用，```mermaid 块永远显示为代码。
3. **根因三（渲染考古）**：mermaid v11 全系（11.4.1/11.12.1/11.17.2，官方 esm.min 同样复现）在本地浏览器 flowchart 标签**静默渲染为空**（盒子按文字测量正确、tspan/span 无内容；securityLevel/htmlLabels/fontFamily/预打包方式均无关，内部零报错）；v10 的 foreignObject HTML 标签在浏览器端会被 DOMPurify 按 SVG 命名空间守卫剥掉 HTML 子元素（jsdom 测不出来，Chrome 实测剥除）。CDN 对照 v10.9.3 + `flowchart.htmlLabels:false`（标签走 `<text><tspan>`）完整存活。

## 修复

**api（A 项，四处）**
- `v3Service.js:1039-1044`：wantsChart 加 relaxed 分支 `relaxedMode ? CHART_INTENT.test(request.message) || Boolean(taskContext?.chartRequest) : <原公式>`；派生链与 validateChart 复用不动；open 模式仍纯文本 finalize，模型不可提交 chart、数字全部来自真实取数。
- `openConversation.js:29-30`：OPEN_SYSTEM_PROMPT 追加图表分工段（数据图应用自动生成/结构图 mermaid 白名单七种/禁 xychart·pie·ASCII 数据画）。
- `v3Prompt.js`：SYSTEM_PROMPT chart 行 + FINALIZE_PROMPT 尾部同款指令；PROMPT_VERSION v4.23→**v4.24**（v4.23 已被并行会话占用）。
- `v3Tools.js:30`：query_data 描述改模式中立（查询/操作模式填顶层 chart；闲聊/分析无需声明、应用自动生成）。

**web（B 项，六处 + 版本钉）**
- `package.json`：`mermaid@10.9.3` **--save-exact 钉死**（v11 全系标签空 bug，见根因三；vite.config.js 注释同步记录）。
- `src/utils/sanitize.js`：新增 `sanitizeMermaidSvg` 独立出口——显式 SVG 白名单（图形标签+foreignObject+HTML 子集）+ `scrubSvgCss` 字符串级 CSS 危险模式清洗（@import/url 外联/position:fixed/expression/javascript:；url 仅放 #fragment 保箭头 marker）。主白名单不动，v-html 铁律不破；DOMPurify 钩子对 <style> 文本不生效的坑改字符串级后置清洗绕过。
- `src/utils/aiMermaid.js`（新）：`parseMermaidDiagramType` 白名单判定（七种结构图，跳 %% 行，-vN 归一）+ `renderMermaidSvg`（lazy import + strict + htmlLabels:false + 模块缓存 30 条）。
- `src/components/ai/AiMermaid.vue`（新）：非白名单/未激活（流式）/渲染失败一律回退代码块；实例内+模块级缓存防 activityClock 每秒重渲染重画。
- `src/utils/aiMarkdown.js`：`getAiMarkdownMermaidBlocks`（与 getAiMarkdownCodeLines 同款 lexer 计行法）。
- `AssistantMessage.vue`：messageSegments 提取 `{ mermaid }` 段 + AiMermaid 分支（:42-44）。

## 验证

- **api**：aiOpenConversation 49/49（新增 4 用例：chat 模式派生 bar chart 全字段断言+business.chart 落库、零行→null+notice、无 chart 词 chart-free×2 模式）；`test:ai` 4574/4577、`test:ai:v3` 1228/1229——3 失败=并行会话 01:03 重写 conversations.js（+321 行，HISTORY_WINDOW 10→4，loadHistory 新 SQL）破坏旧 mock，本改动集零交集（M02 走 query 模式不触发本改动分支）。
- **web**：aiMermaid.test.mjs 5/5（新）+ aiAssistantUi 29/29（+2 用例：白名单内才尝试渲染/xychart 不触发/回退代码块）；`test:ai` 297/302——5 失败=并行 aiContract.js/Assistant.vue 在途；`test:ui` 1/2——Login.vue 并行改动。生产构建 `npm run build` 成功，mermaid 独立懒加载分包。
- **浏览器（IAB 350px，真链路）**：D1 闲聊「画个柱状图看最近六个月收支」→ ECharts 柱状图卡（标题服务端重建「收支月度趋势（2026-06-01 至 2026-11-12）」+双系列+精确刻度+数据卡，正文数字与图一致）；D2 mermaid flowchart 三节点 SVG 渲染+文字清晰（截图）；D3 要求 xychart → 模型按提示词主动拒绝并退成 Markdown 表格；D4 多次 reload 后 AiChart canvas+mermaid 图+文字全部从持久化恢复；D5 全程 350px 移动视口布局正常。

## 落档

- 计划与执行证据：`PLAN_AI_CHART_ALL_MODES_MERMAID.md`（仓库根，A-D 逐项勾选+补记）。
- 轮号：构造书 §0.5 新行插最上 + temp/构造书/rebuild-app-Docs/07-变更核实清单 尾部（追加172）。
- 三处记忆同步：.codebuddy/memory + Qoder + ZCode。

## 遗留与观察项

1. **artifact 状态分类器措辞碰撞**（既有逻辑，非本轮引入）：画图请求原话含「草稿+核对」时被 `asksConversationArtifactState`（conversationArtifacts.js:6-11）误判为查存档状态，模型答案被「本会话目前没有实际保存过草稿或提案。」权威替换（v3ResultAssembly.js:62-64 的 artifactStatusAnswer 门控不检查本轮意图）。建议后续给分类器加图表词豁免或意图判定。
2. 并行会话在途改动（conversations.js/aiContract.js/Assistant.vue/Login.vue）带来的测试基线波动以其收口为准。
3. mermaid v11 标签 bug 值得上游报 issue（v11.4-11.17 复现，v10.9.3 正常）；升级 mermaid 前先跑 flowchart 标签探针。
4. `messageSegments` 每秒重渲染 markdown 的既有问题未动（本轮靠 AiMermaid 缓存兜住 mermaid 侧）。

---

## 来源：CHANGELOG_2026-11-12_AI_CHAT_NUMERIC_EVIDENCE.md

# chat/analysis数字证据门修复（2026-11-12）

承接交接审计发现的真实缺陷：chat的relaxedMode跳过严格查询数值重建，模型未调用calculate便发布了净资产71370、正资产79870；该轮实际数据只能计算出61870与70370。预算日均、工资示例、基金比例也出现无回执派生数字。

## 变更

- chatNumericEvidence纯函数按本轮已发布numeric列/summary和真实成功calculate回执核验。使用带符号的精确十进制规范值，识别千分位、中文与万单位金额/数量；日期、身份名称、布局刻度不作金融数字白名单。
- calculate结果不是万能证明：校验算式输入来源并重新确定性求值；裸数字、未知输入、符号洗白、伪造value、失败回执均不能支持账本结论。支持前序已证明计算结果串联，不新增datasets。
- 明确的用户/模型讨论假设只支持该情景参数及有calculate回执的派生结果，不可变成“当前/已保存/实际账本”数值。模型假设参数提取到预测动词前，预测结果不能自证为输入。
- v3Service在实际业务读取后发现未核验数字，仅在预算还容纳计算+终稿时给一次纠正；该阶段definitions及runTool仅calculate，终稿仍无工具，调用上限5、工具上限8及日额度保持。
- 原执行claims在纠正前核验，最终原claims→授权复验→提交路径保留。纠正仍不符或无余量时逐句/表行/图块净化，并补直接已发布事实，不整段删空、不把资金执行声明洗成成功。
- 结构图保留，金融标签/数据图数字仍检查；图轴范围只表示布局。代码围栏中的金融断言和财务标题下裸数不能绕过；独立闲聊/编程/web没有读业务时保持原行为。
- 数字门前先采用既有egress，避免电话号码误判为金融数字。安全引用保留本轮成功URL；web值不进入账本证据。
- v3ResultAssembly在完整compose后再次净化，防回退名称/title重引入错误数。append与recovery只保存最终安全答复。
- live失败报告增加脱敏失败阶段/最新模型正文摘要，后续可定位参数与claims问题；不放松现有错误门。

改动：service/chatNumericEvidence.js、v3Service.js、v3ResultAssembly.js；tests/unit/aiChatNumericEvidence.test.js、aiChatNumericEvidenceReplay.test.js、aiOpenConversation.test.js（原假设建议断言保留，增加实际calculate脚本）；tests/eval/aiEvalLive.evaltest.js（失败证据）。没有数据库迁移、没有.env修改或生产发布。

## 验证

- 新增helper28项与实际V3重放18项通过；初始错误数字能实际泄漏的重放已转绿，证明不是仅测helper或仅改prompt。
- 定向8套/281项通过，包括现有open场景、假设建议全文保留、隐私脱敏、web与业务数据隔离、有限预算及原claims门。
- 默认全回归213套/4863项通过，结果 [full-tests.json](../../temp/ai-chat-numeric-20261112/full-tests.json)；7个改动源码/测试语法检查通过，已跟踪改动空白检查通过。
- 同8个live种子、同一最终评测口径的真实模型两轮复测结果待下节追加；原失败报告保留，不覆盖。

## 最终收尾（2026-11-12）

- 实测过程中还补了超量calc-only批次安全终稿：仅在已读业务的chat/analysis、批次≤8且全部calculate包装合法时整批零执行、配错误回执、无工具终稿。未扩大工具8次/模型5次上限；非calc/混合/终稿强行工具仍拒。重放新增4项通过。
- 伪tool_call文本不会执行或变实际回执，净化后展示已查询事实；空模型正文同样返回已发布事实，避免只有覆盖说明。实际V3重放最终24项通过。
- 明确假设参数按条件边界提取，不采预测动词/逗号结果/等号右侧；无calculate的150工资示例不能洗白。合法真实计算的1000×3=3000情景保留。
- 分期计数只作“已返回窗口的保存状态”证据，不作真实还款或本轮执行证明；剩余期数缺字段时不拿总期数6冒充剩余6。全局执行claims没有放松。
- live评测补完整UTC小数秒、明确截至月日、中文日期与正确年/月上下文匹配；50/8500、450/1450、错误年份仍拒。原黄金分期错误的“总期数=剩余期数”参考答案同步纠正。
- 历史报告保留：_3为7/8（超量计算批次失败）、_4为5/8（日期格式误报+假设150漏口+分期误判）、_5原始6/8经相同原文/隔离SQL和日期格式规则复核为8/8，见 [格式复核证据](../../temp/ai-chat-numeric-20261112/format-recheck.json)，不是新模型运行或模型能力提升；_6为5/8（伪工具/空正文/分期误判），_7最终真实运行7/8，七个数据域成功且数字接地全绿，剩分期正常零状态陈述被错误门拒绝，采用捕获原文和真实preview复核，不再重复付费。
- 最后全量结果与分期捕获复核会写入下节；所有历史失败报告保持原状。

## 最终验收结果

- 最后代码冻结后的默认回归 **216套/4961项全绿**，结果 [JSON](../../temp/ai-chat-numeric-20261112/full-tests.json)；实际V3重放24项，helper31项及分期计数/剩余反证通过。最后两个分期修复后的7个关键文件语法/已跟踪空白检查均通过。
- 最新真实模型运行 [report_7](REVIEW_2026-11-12_AI_EVAL_sensenova-6.8-flash_7.md)：同8例7/8通过，预算/待办/资产/基金/工资/规则均通过且数字接地全绿；分期诚实零状态答复被存量门误拒。最后根修以完整实际preview和捕获原文做 [零费用复核](../../temp/ai-chat-numeric-20261112/installment-report7-recheck.json)，原claims正常通过；缺证据/计数不同/actor执行仍拒绝。
- 没有再运行付费模型。不能把上述捕获复核称为“新的8/8真实运行”或把一轮报告替换成绿；原报告保持7/8，最终代码及捕获验证分别记证据。
- 本轮已完成数值缺口修复和接手收尾，不继续追逐随机模型措辞。搜索AI_SEARCH_*仍未配置、真源/计费待独立验收；生产部署/D形态确认未执行，当前业务连接和.env未变。

## 证明边界

本轮核验数值和算式来源，不等同于完整自然语言语义核验。同一个已发布数值仍应按对应数据集、时间范围和统计口径解释，不能把回归通过表述为所有金融陈述零幻觉。

当前AI_SEARCH_*未配置，搜索真源/计费验收仍待配置；生产和D仍按原独立门槛处理。

---

## 来源：CHANGELOG_2026-11-12_AI_HANDOVER_AUDIT.md

# AI交接审计与接手实施（2026-11-12）

原交接不能直接视为可执行验收证据。本轮先核对源码、工具、DDL和运行配置，再完成live补种子与web_search实现；生产发布与D保留既定门槛。

> **后续收尾状态（覆盖下文历史待办）**：本日记发现的chat数值漏洞已继续修复，来源核验/有限纠正/安全回退/假设隔离及分期计数误判均已落地。最新真实运行7/8，剩分期捕获原文+真实preview复核通过，不再烧模型费用追模板。详见 [修复日记](CHANGELOG_2026-11-12_AI_CHAT_NUMERIC_EVIDENCE.md)；下文TASK_INPUT保留为历史，不能当仍未动工。

## 审计纠偏

- 生产grant跟随api/.env的DB_NAME，当前是live_mock_20261112，不保证生产live；工具也不校验完整18表授权集合。生产PLAN改为独立环境、显式目标、首次单表授权引导与完整授权审计。实际候选迁移是019，不是020；ai_config INSERT必须给updated_at；启动须INIT_SKIP=true，不能顺带跑历史迁移。
- live套件固定DROP/CREATE live_ai_test；PROFILE_USER只选来源密文，不能靠改用户就直跑生产。生产PLAN移除该错误步骤。直接SQL把profile.is_active置0不能可靠撤权（L1和fallback），回退改撤授权或总闸。
- D原把备份任务ai_background_job当通用空表，其proposal_id必填、queued状态、receipt字段均不支持原方案。修订为待确认ai_insight提案，明确GET只读/POST显式生成、日额度与并发分开、持续授权/原子入场/lease。未代勾§2，未实施D。
- C原称offline已入默认回归，但package.test:ai没有tests/eval。本次显式纳入；搜索client/tools/citations也纳入默认回归。
- live接地原substring可把50当8500证明，改完整规范化数字匹配；用户原话仅能证明匹配的真实交易草稿，不能为一般账本数字背书。工具序列仅记录；措辞与scripted不同不能证明证据门接管。
- 真缺陷：currentTurnIntent把“先读取已保存记忆”误判写入，再受前半句“有什么偏好”干扰，导致多付费一轮模型。修既有状态与显式读取优先，原M02三次调用断言保留，另补12边界。

## 已实施

- tests/eval/liveFixtures.js独立补预算/待办/工资与规则/基金/分期/资产组成，相对上海今天；固定隔离库和测试用户检查先于写入。未改共享real harness。
- webSearchClient/webSearchTools：两家官方独立API、单源无重试或failover、chat双门、每轮2次、出域脱敏和回域untrusted、有界当日缓存/同query并发去重/每用户重投影。
- webSearchBudget：ai_config三列原子预占全站额度；失败不退款，跨进程/重启共享，迟到旧日不回卷。旧schema保留原六项预算覆盖，搜索缺列失败关闭。ai-search-migrate明确数据库参数、幂等、只改ai_config，尚未对当前开发库/生产库执行。
- webSearchCitations：擦所有搜索opaque refs，来源URL原始/编码检查，最终只保留本轮成功回执里的完整HTTPS来源；混合查账仍严格脱敏。web不进入datasets或账本金额/执行claims。
- 新增1条黄金web引用用例（总32条），offline假搜索客户端；live未配源逐项SKIP不计通过。

官方映射核实：DeepSeek https://api-docs.deepseek.com/api/search.md；智谱独立Web Search API参考。DeepSeek不支持recency；智谱限70字符，固定search_std。文档和fixture已记录来源。

## 验证与证据

- 实施前默认基线：204套，4662通过/6失败。5项历史/日期夹具失败由并行聊天收口，本轮未覆盖那些文件；M02真缺陷由本轮修复。
- 接手实现默认全回归：211套/4810项通过，见 [结果JSON](../../temp/ai-handover-audit-20261112/final-tests.json)。后续评测格式修正的最终结果追加于本节末尾。
- 搜索/评测定向：8套/126项通过，见 [定向结果](../../temp/ai-handover-audit-20261112/search-eval-targeted.json)。关闭/半配置的provider消息、工具、options序列化字节一致；双场景门/三次拒绝/缓存/脱敏/来源/账本数字隔离均有反证。
- 零付费真库回读：live_ai_test七数据集命中数字；两个独立池20并发仅2次预占，同日新store拒绝、次日重置2次、延迟旧日不回卷。测试ai_config行已清除。复跑入口tests/eval/verifyLiveFixtures.js。
- 真实模型第一轮：同8个补种用例，sensenova-6.8-flash，报告 [run1](REVIEW_2026-11-12_AI_EVAL_sensenova-6.8-flash.md)。原始严格1/8，报告保留；含千分位格式误报，也含真实未接地派生数字（预算日均27.5无calculate、规则100/200示例无calculate）和todo模型两次违约参数后正常终止。不能称§11真模型验收已通过。
- 第二轮同8例报告 [run2](REVIEW_2026-11-12_AI_EVAL_sensenova-6.8-flash_2.md)：严格3/8；8域种子要点在成功答复均命中，todo/工资通过。预算/资产/基金/规则仍有无calculate的派生数字，分期答复触发缺执行回执门拒绝。资产正项52000+18050+320应为70370，净值扣8500应为61870；模型却写正资产79870/净资产71370，且该轮只有query_data、没有calculate。属于真实算术质量缺口，不是种子或格式问题。
- 两轮之间修复了千分位/日期/负号判定，并核验实际calculate审计value（须与toolTrace及结果SHA-256相符）；因此1/8→3/8不能当作模型能力改善。第一轮原始失败报告不覆盖。
- 最终默认全回归 **211套/4817项通过**，上述final-tests.json是最终结果；16个关键源码/执行器语法检查通过，已跟踪本轮文件空白检查通过。真实模型两轮失败不改变离线绿的事实，也不能被离线绿豁免。

## 续接边界

当前API .env仍指live_mock_20261112；未切连接、未写该库或生产账本、未部署生产。隔离评测读取来源profile密文并调用既有商汤模型，不输出明文Key。

当前AI_SEARCH_*三槽均未配置，web_search代码验收完成、真搜索源与计费验收待配置。不能用假端点测试冒充真源通过。D形态确认、生产目标/账号与发布授权继续独立处理。

按总计划停止规则，**不宣布§11 live验收完成，不开搜索闸，不推进生产/D**。下一步应先收口chat已取账本后的派生数字约束与模型tool参数依循，再按相同种子/同一口径复跑；不能继续沿用“没有必须处理技术债”的原交接结论。chat现行relaxed输出绕过严格查询的数值重建，具体门控须兼容已批准的AI正文Mermaid与计算回执，不以强行切回旧query模式掩盖问题。

入口：总计划顶部索引、PLAN_AI_WEB_SEARCH.md §6真源TASK_INPUT、修订后的生产/D计划。源码实现、真实SQL和真实模型质量分开记状态。

## TASK_INPUT（下一项：真实质量门修复）

```text
TASK_INPUT:
task_type: fix
target_project: api
goal: chat取账本后的派生数字必须有确定性回执，消除已复现净资产错误并提高工具参数依循
files:
  - api/src/modules/ai/service/v3Service.js
  - api/src/modules/ai/service/v3ResultAssembly.js
  - api/src/modules/ai/service/v3Prompt.js
  - api/tests/eval/
constraints:
  - 先读本日记与两轮真实报告；保留失败证据，不放松grounding或增加不真实allowedNumbers
  - chat的relaxedMode不应让已取账本的数值绕过核验；复用账本已发布数值和成功calculate回执，具体实现先评审现有呈现路径
  - 保留已批准的自然闲聊、AI正文Mermaid和现行模式，不能把chat偷偷切成旧query或整段删回答
  - web结果仍不成为账本数字/草稿/执行证明；未知输入和执行回执继续fail-closed
  - 源码当前大量在途与未跟踪改动，最小补丁，不覆盖并行工作
acceptance:
  - 离线复现71370净资产错误被阻止，合法61870及有成功calculate回执的派生数字保留
  - 预算无回执日均/工资无回执示例/基金心算比例均不泄漏
  - 默认回归绿；同8种子同一最终rubric两轮真实验收红线过，再推进搜索真源与生产灰度
evidence:
  command:
  error_summary: 两轮真实质量门未过；run2无calculate却给净资产71370，真实值61870
  notes: 隔离SQL已证实种子，不要继续补数据掩盖模型算术问题
```
