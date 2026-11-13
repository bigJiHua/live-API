# 2026-11-09 变更日志（合并）

> 本文件由当日独立日志按日期合并，来源见各节标题。

---

## 来源：CHANGELOG_2026-11-09_AI_DATASET_CAPABILITIES_PLAN_V2.md

# AI 数据集能力表计划按评审修订（2026-11-09）

## 依据

`logs/REVIEW_2026-11-09_AI_DATASET_CAPABILITIES.md` 判定 v1「方向对，但不能原样实施」。本轮按评审 8 条意见重写根目录 `PLAN_AI_DATASET_CAPABILITIES.md`（102 → 157 行，标记 v2），**未实施方案、未改源码、未跑测试、未调用付费模型**。

## 修订内容

1. **阶段 A 重新定义为「保持现有行为」的兼容重构**：删除 A2 的按数据集裁剪（`definitions` 逐字不变与裁剪互斥）；模型侧裁剪、移除 `direction`、枚举合并全部移到最后的阶段 D。
2. **补齐财务第二校验入口**：A4 纳入 `financeDatasetRead.js:14-28` 的 dataset / direction / sort / filter 规则与规范化；A3 只替换 `query_data` 能力分支，保留 `v3Tools.js:81-83` 的 `list_choices` 域/候选组规则；错误码 / status / 诊断兼容范围单列，禁止兼容阶段统一改码。
3. **能力表改三层结构**：`acceptedArgs`（允许输入、组合限制、filter 支持与覆盖范围）/ `defaults + normalization`（默认值与输入→执行映射）/ `effectiveMeta`（实际范围、排序、方向、粒度元数据）；SQL 聚合与金额计算仍归 reader。
4. **所有权与单向依赖**：注册表为纯数据叶子模块，不导入工具/reader/service/DB；`domain` 唯一存于注册表，`v3Tools` 派生导出 `DATASETS`；`CHOICE_GROUPS` 独立保留，避免 `v3Tools → businessRead → financeDatasetRead` 反向成环。
5. **独立验收**：预期不从同一张表生成；固化改造前 `definitions` 基线、独立于表的契约矩阵、reader → 预览 → `queryMeta` → coverage → 最终回答链路回放、固定业务数据场景（跨月按卡累计 / 单月排名 / 最大单笔 / 最大一天 / 零记录 / 截断 / 未定价 / 连续追问）、R01–R10 与全量回归、行为等价断言。
6. **C1 自纠预算闭合**：明确错误分类（Joi 默认 `AI_INVALID_INPUT`、财务 reader 在 catch 之后抛错）、失败尝试计数与去重、整轮一次、模型/工具/token/字节/截止时间全预算、多工具配对与保留已成功授权、第四轮失败不追加第六次；验收须用实际 `requestGuard` + 模拟执行器。
7. **C2 并入阶段 B**：承认 toolResult 已含 `scope` / `queryMeta` / `queryNotice`；`effectiveArgs` 从最终 `queryMeta` 或执行规范化结果生成（不得复制 `validateTool` 的 args），白名单投影、脱敏、计入字节预算，保留原始 `inputArgs`。
8. **删除启动自检降级为 `console.warn`**；静态契约不一致启动即抛，环境配置检查单独处理；回滚按实际文件清单只撤本次变更。

事实表述修正：业务原生工具 2 / 全部 8；`taskContext` 用 `subject` 且需考虑多主体；「用户确认才写库」限于正式业务执行（`memory_write` 为工具阶段即时副作用）；「不可能再漂移」改为「减少重复声明并用独立链路发现漂移」。

**实施顺序改为：兼容重构 A → 字段诊断与有效参数 B → 有预算保护的自纠 C1 → 模型契约调整 D。**

## 本轮源码核对（只读）

- `errors.js`：`AiError` 默认 code 为 `AI_INVALID_INPUT`；`validation.js:41-44` 的 `validate()` 未显式传码。
- `financeDatasetRead.js:14-28`：`invalid()` 抛 `AI_TOOL_ARGUMENT_INVALID`，且把 `finance-categories` 规范化为 `categoryAmountDesc`、`finance-monthly` 规范化为 `monthAsc`。
- `businessRead.js:472` 调用 `prepareFinanceDatasetQuery`；依赖方向 `v3Tools → businessRead → financeDatasetRead`。
- `requestGuard.js:256-260` 的 `tool()` 有 12 次上限与同参数去重；`v3Service.js:40` 为 `MAX_PROVIDER_CALLS=5 / MAX_TOOLS=8 / 16KiB / 64KiB`；`:505-520` 的 toolResult 已含 `scope` / `queryMeta` / `queryNotice`，callLog 记原始 `inputArgs`。
- `v3Service.js:432` 使用 `taskContext.subject`，不是 `domain`。

## 验证

本轮仅文档修订与静态源码核对；未执行 jest、未调用供应商或数据库、未操作服务进程。计划中的 79 套 / 1787 项为历史基线，实施阶段须重跑。

---

## 来源：CHANGELOG_2026-11-09_AI_DATASET_CAPABILITIES.md

# 2026-11-09 AI 数据集能力表与真实链路修复

状态：本轮 A、B2 与实际失败追加修复完成，最终真实接口和页面验收完成。C1/D 未实施。

用户明确要求最终实际效果，2026-11-09 明确授权并要求调用付费模型。此前计划的仅静态/不付费限制被该请求覆盖。业务交易数据只读，使用现有 5173/7788，不启动额外服务，不执行旧 real harness 或业务 seed。

## 实施

- 阶段 A：新增纯数据叶子模块 `src/modules/ai/service/datasetCapabilities.js`，23 个数据集分离允许输入、默认/执行规范化和有效元数据声明；工具校验、财务第二入口、卡读取、元数据和上下文共用声明。SQL 与模型工具 definitions 保持兼容，静态矛盾启动抛错。
- 独立基线：`tests/fixtures/aiDatasetDefinitionsBefore.json` 和 `aiDatasetBehaviorBefore.json` 固化改造前定义与人工推导契约，测试预期不从新注册表生成。
- 真实卡排名揭示前端 DTO 漂移：`web/src/utils/aiBusinessContract.js` 接纳限定数据集的 `queryMeta.groupBy` / `filters.cardTypes`，同步验证最终响应和历史恢复。
- 阶段 B2：新增 `queryEffectiveArgs.js`，获准结果中的实际范围/排序/方向/分组/卡类型优先，以白名单反馈 `effectiveArgs` / `argumentAdjustments`。保留原始工具参数审计，缓存反馈也重算差异并计外发字节。
- 当前卡任务承接：信用卡类型切换保留月份范围；老任务缺 scope 时从同类型最近 coverage 恢复，旧借记卡查询不会扩展当前信用卡口径。明确月走势使用 `cardMonth/dateDesc`，不放行未知分组或收入请求。
- 真实走势失败追加编排修复：整批工具仅重播已获准业务查询缓存时，配对所有 tool result 后进入下一轮无工具最终化；混合新查询、历史与记忆工具不触发该提前最终化。保留原 5 次模型、8 个工具、30000 token 和外发上限。
- 月走势图按卡片分别画线并对齐月份，无记录显示空点；使用已有单元数值，不汇总金额。重复卡月或不合适的月度饼图停止成图并保留答案/明细。标题和图例使用页面文字颜色，暗色页面可读。最终提示版本 `life-assistant-v4.10`。
- 真实正文核对发现：`YYYY-MM` 被数字校验误当金额，正确花呗月份行被删；模型把缺月误述为每月消费/持续回落。月份标签已修正；卡月正文直接引用获准卡/月/金额/笔数单元，明确缺月和末月截至日期，与图表同源。
- 事实完成路径：口径明确的完整卡月图、完整收支月图，以及已证明全范围排序的财务极值，在模型选工具、实际只读取数、预览授权与外发投影后，直接用固定事实包通过 `validateOutput` 及后续共同授权、图表、claims、持久化/回执流程。提案和待补意图固定为空，审计新增 `grounded-completion`。这些简单查询不再需要再次将全批财务数据送模型生成答案；不完整排名、比较、多工具混合和分析请求继续原流程。模型 definitions 与预算上限仍不变。

## 真实基准与失败记录

当前供应商为本人实际 profile 的 `token.sensenova.cn / sensenova-6.8-flash`，沿用原失败用户的授权；只输出身份摘要，不保存密钥。

独立基准从本人原始数据只读取必要字段，使用 BigInt 十进制核算：

- 5 月购汇 2 笔 2973.14，最大一笔 5 月 14 日 2626.80；5 月最大支出日也是 5 月 14 日，当日 2714.39。
- 6 月支出 5784.61、收入 3911.24，共 268 笔（153 支出 / 115 收入）；最大单笔 6 月 18 日 999.00。
- 最近三个月为 2026-09-01 至 2026-11-09；借记卡累计第一农业银行7476，183.32；信用卡累计第一花呗，866.00。
- 信用卡逐卡月行：花呗9月666.00/10月200.00；浦发新贵卡9月19.38/10月17.38；超惠真金11月39.91。11月只截至9日。

真实失败保留而不抹去：原月走势先因不支持 monthAsc 失败；有效参数反馈修复后仍反复查询，累计 token 超限；另有 nodemon 重启瞬间连接断开，零供应商调用。人工发现的三次正文/口径错误即使 HTTP200，也改记为验收失败并保留原响应。供应商有4次真实 `400 / code 9 / safety check failed` 拒绝，没有替换供应商或隐瞒失败。对应请求、原参数、获准参数与供应商消息均在下方脱敏证据目录。

## 最终验收证据

证据目录：`D:/Code/live/temp/ai-dataset-capabilities-20261109/`。

- 离线：后端 **87套 / 1863项**、前端 **149项**全部通过。基线 definitions 精确快照、独立输入矩阵、真实 reader/preview/egress/context/answer 回放，以及实际 requestGuard 缓存收尾/回执验证包含在内。仓库原有 Jest `ignorePatterns` warning 未改。
- 真实：共 **25次请求尝试、62次供应商调用尝试**（58次供应商成功返回），API200但正文错误也记失败，全部历史尝试不是全绿；**按各场景最后一次结果全部通过**。供应商已报告 token 总计428973（prompt416508 / completion12465），此为usage，不推算账单费用。
- 最终代码连续卡链：借记卡第一农业银行7476/183.32 → 信用卡第一花呗/866.00 → 月度走势图（真实 `/v3/chat/stream`，实际前端SSE解析器），范围9/01..11/09、5卡月行/6笔消费、3卡系列逐点核对成功。最后图请求仅1次供应商调用，约6.3秒。
- 最终代码连续财务链：6月收支图 → 无月份原话的最大单笔追问，范围6/01..6/30、268总笔数、最大999.00均正确，最后两请求各1次供应商调用。原财务对话中的6月图也最终复测通过。5月购汇/最大日和6月50条截断明细已有本轮真实通过记录；这些早期结果不冒充全部在最后版本重跑。
- 上下文：14个成功回合的获准 queryMeta 持久化核对通过；实际后续供应商 TASK_INPUT 携带范围/数量/筛选/覆盖状态。25请求回执重读、5聊天HTTP历史及实际web恢复验证通过，新增供应商调用0。
- 页面：实际Vue页面刷新后恢复成功；分别观察6月收支柱图与信用卡3卡月度线，展开数据显示1个月/268流水、5卡月行/6流水。截图 `ui-finance-chart.png`、`ui-finance-range.png`、`ui-card-monthly.png` 在证据目录，未用mock页面替代。
- 业务变更：测试写 AI 聊天/预览/审计/回执，**草稿/提案/交易候选均0**。23个业务表摘要基线在前7次尝试后才捕获，04:48:07 UTC之后的验收比较为 unchanged；不冒充此前全程无变化的哈希证明。

主要证据：`api-regression-final-410.json`、`web-regression-final-410.txt`、`baseline.json`、`card-month-baseline.json`、`live-state.json`、`live-audit.json`、`live-summary.json`、`final-readback.json`、`final-metrics.json`、`business-before-remaining.json`、`business-after-remaining.json`。

最后真实请求定位：卡月SSE `62cfefb1-2ba0-4d2b-9299-04f77beb053f`；6月收支图 `40a74ee0-e0f0-4fa9-b24a-8729ee1e9814`；最大单笔 `cc0d6951-7e7a-4acf-b95e-da5485f24e2c`；原财务对话6月图 `1a1bebe5-1214-4db1-a9e6-d641ac160f0b`。

C1 参数错误单次回灌与 D 模型 schema 裁剪尚未实施。当前结果不能声称 8工具/23数据集/15业务提案的所有真实场景已打通。

---

## 来源：CHANGELOG_2026-11-09_AI_INCOME_DAILY.md

# 2026-11-09 日收入极值和日期语义契约

问题：finance-daily仅有支出金额排序，问“收入最多哪天”被按日期倒序取月末窗口。另财务reader queryId允许24..64hex，而preview只接受24hex。

改动：新增仅适用daily的incomeDesc，贯通能力注册表、模型分支、SQL、V3意图规范化、获准排名正文、web DTO和覆盖提示；收入方向选择income列，支出方向选择expense列。queryId统一24hex。8个保存状态数据集的datePolicy.semantics为saved-state、分期为mixed-plan-state、其余date-range，工具明确保存状态不能重建历史时点。

验证：先复现4个失败，再修复。独立回放5套113项通过，web收入图表DTO/option新增1项通过；保留725/384旧行为基线，旧definitions只允许incomeDesc枚举这一明确增量，不重新录制历史基线。证据位于`temp/ai-all23-20261109/g07-g09-*.json`及`g07-g09-repair.md`。真实付费效果验收与这些隔离测试分别统计。

没有改用户业务表、授权、金额、SQL或preview安全门。

---

## 来源：CHANGELOG_2026-11-09_AI_MEMORY_SOURCE_EFFECTS.md

# V3 记忆来源保真与失败副作用披露

日期：2026-11-09，Asia/Shanghai。

已知 G13：用户真实原话“喜欢红色”被完整引用，但模型把正文写成“喜欢蓝色”，旧门仍返回 saved。已知 G05：工具已经保存文件，随后最终 JSON 校验失败，用户收到整轮失败却不知道记忆已生效。旧现场通过真实 memoryStore 文件系统 + 隔离 V3 fixture 复现，证据在根 `temp/ai-all23-20261109/memory-boundary-audit.json`；没有调用供应商或真实数据库。

## 本次修改

- `memoryEvidence.js` 校验新增正文保留完整真实 user turn，包含否定、例外条件和跨行上下文；不能仅因为 evidence.quote 是合法子串，就授权任意摘要或截掉“不”字。可使用不改变原文的 blockquote 包装。
- V3 写入前校验完整来源，存储元信息 source 也保留完整原话。create/read/append/replace/patch 保持开放，patch 以完整原话记录为单位，防止片段替换改写句意。
- `memoryTools.js` 明确完整原话、记录分隔、完整记录 patch 与实际 saved 回执的约束；`memoryStore.js` 说明存储/编码/CAS 校验不等于任意事实改写的语义证明。
- 服务器使用实际 saved 且 changed 的文件回执生成副作用提醒。若随后校验、存储或取消失败，HTTP 错误、历史失败气泡及持久化失败回执均说明这些已保存记忆已经生效。失败消息按 Unicode codepoint 截断，避免拆断合法字符。

采用的是诚实副作用披露 fallback。文件依然在 memory_write 工具执行时即时保存；尚未实施跨数据库和文件系统的原子事务、outbox 或进程崩溃恢复。不能据本次变更宣称整轮失败会回滚记忆，也不能宣称可自动证明任意改写摘要的语义正确。进一步 stage/outbox、CAS 和取消决议设计见 `temp/ai-all23-20261109/memory-staging-design.md`。

## 验证

生产模块 7 套 / 246 项通过：memoryEvidence、memoryEffectsReplay、memoryStore、memoryTools、V3MemoryReplay、requestGuard、V3Service。新增 9 项验证真实隔离 UTF-8 文件四种写操作、读取、红蓝矛盾/否定删除拒绝，以及 JSON 失败/取消后的 guard 回执跨实例恢复；另新增 2 项 V3 严格拒绝旧摘要与截断否定的场景。旧有效写入 fixture 改为完整用户原话，拒绝门没有放松。

证据：`temp/ai-all23-20261109/memory-production-first.json` 保留首次 7 项旧摘要 fixture 失败；最新全通过证据为 `memory-production-final.json`。该回归为 0 供应商调用、0 真实数据库调用。`memory-live.cjs` 已准备真实本人 runtime / 商汤 / guard / preview / 独立 manual 聊天验收，记忆文件仅写专用 temp 目录；根协调任务负责运行付费场景与最终实测报告。

---

## 来源：CHANGELOG_2026-11-09_AI_QUERY_PRESENTATION.md

# 2026-11-09 查询意图、展示数量与中文日期范围

真实付费全数据集批次发现，模型选择的参数本来正确，但服务端把“最多展示10条”识别成金额极值，把“匹配数量和本次展示数量”识别成卡片数量，导致每日收支只剩支出冠军、逐卡逐月消费被改成卡片数量。卡片清单的“账单日”也会污染后续任务。中文“2026年11月1日至9日”则被截成11月1日单日。

改动：共享展示文字清理函数只在意图判断中去除展示上限、展示序号和查询元数据数量，保留真实金额最大、最高和第一名；普通每日汇总清除旧极值；卡片账单日不再识别成账单金额查询；筛选和展示追问保留原日期、指标并允许清空文本筛选。中文日期解析支持省略月份的范围末端和跨年，明确无效日期以AI_SCOPE_INVALID终止，不能回退到默认月。

验证：补丁应用前的34项专项验证18失败、16通过；应用后生产专项34/34通过。持久回归新增27项，Query/Task/V3相关8套130项全部通过，含真实V3路径的卡消费展示限制回放。专项证据为`temp/ai-all23-20261109/query-presentation-before.json`、`query-presentation-production.json`；完整Jest结果为`query-presentation-api.json`。真实模型复验由全数据集验收批次单独记录，离线结果不替代付费验收。

本改动涉及queryContext、taskContext以及V3卡消费意图归一化，不改用户业务数据、记忆处理、授权、金额、SQL或预览校验门。

---

## 来源：CHANGELOG_2026-11-09_AI_TOOL_RECOVERY.md

# 2026-11-09 工具参数恢复与多主体范围

用户要求继续可靠性策略，并维持真实付费模型验收授权。服务沿用现有7788；不新开终端窗口、不启动另一套服务。业务数据只读，测试只保存AI聊天、回执、预览和审计。

## 实现

- `toolRecovery.js`仅标记明确输入校验边界的错误。错误码相同的SQL/预览失败不能触发恢复，身份、SQL、连接和凭据字段不回灌。反馈仅包含字段路径、规则和允许值。
- `v3Service.js`整轮只允许一次参数纠正；一个响应的不同参数错误统一配对后一起纠正。失败计入8工具上限，重复失败参数立即终止。成功缓存不因纠正另一个工具而重新查询。第四轮错误只进入第五轮无工具最终化；不增加原5调用/30000token/16KiB与64KiB/原截止时间上限。
- `financeDatasetRead.js`标记其独立参数校验错误；内部queryId故障不作为模型纠正机会。日期错误的字段反馈由编排层生成，旧工具校验code/status/诊断快照不变；原话包含无效日期时不允许模型替换。
- `modelToolDefinitions.js`保持8个工具名称、全部23个数据集与其余7个定义，query_data用互斥anyOf分支声明实际可用参数。卡消费分支省略direction并统一amountDesc；月度/分类/每日/逐笔使用各自规范排序。旧v3Tools定义仍用于阶段A兼容快照，新模型定义单独验收。
- `queryTaskBindings.js`将“最近三个月借记卡排名，同时6月收支图”等独立主体分别绑定范围，TASK_INPUT新增currentTasks。保存各自任务与获准覆盖，财务查询游标随实际财务子句更新。
- 混合任务的事实答复按各自获准数据构建后组合，不依赖工具返回顺序；唯一图表要求从对应子任务补全。多主体任务不会因其中一个完整查询提前结束。参数纠正后没有可用文字或事实时拒绝空成功回执。
- 记忆读取的底层去重加入仅服务器控制的memoryEpoch，保存后相同参数读取可得到新revision；相同写入仍只执行一次。预算和连接终止错误不再被记忆工具包装成普通错误继续处理。
- 真实信用卡追问抓到保存层的二次污染：`conversations.append/loadTaskContexts`重新将单taskContext覆盖完整registry。现单上下文先选择所属独立binding；同turnId完整registry优先，新turnId仍可正常替换。旧污染测试会话保持原样，使用新manual会话复验。
- 未读取的财务子任务在实际会话保存后继续保持pending，不强制写成成功。完成阶段审计名改为`grounded-done`（13字符），匹配真实`ai_call_log.phase VARCHAR(16)`；不迁移业务表，不伪造此前缺失日志。
- 提示词版本：`life-assistant-v4.11`。

## 验证

统一回归：后端93套1943项、前端149项通过。新恢复回放26项，包括真实requestGuard与加密预览、审批、请求绑定、ref和下一轮上下文；7项经过实际会话保存/恢复门；实际call-log写入器核对SQL列宽。首轮3项失败保留在api-regression.json；api-regression-final.json与api-regression-persistence-final.json为中间收尾，api-regression-audit-final.json为最后全量。前端证据web-regression.txt。真实验收完成，证据独立放在 `temp/ai-reliability-20261109/`，不混入前轮62次供应商调用。

真实结果：8次请求尝试、5个独立manual聊天、19次商汤调用，19条成功provider记录。报告prompt149398、completion3217、total152615 tokens；15次真实工具外发携带23分支anyOf并获接纳。最新五类场景全部通过，allAttemptsPassed=false保留旧switch功能语义失败；它的HTTP结果曾completed，但错误继承财务图表，已修复并在新链复验。

| 场景 | 最新结果 |
|---|---|
| 最近三个月借记卡排名，同时6月收支柱图 | 2026-09-01..11-09农业银行7476为183.32；6月收入3911.24/支出5784.61/268笔；两项范围、数量、图表与coverage独立 |
| 信用卡呢 | 继承9月1日至11月9日，花呗866.00；全类型支出942.67/6笔；chart=null，不继承财务图表 |
| 独立6月图→最大单笔 | 分别1次模型调用；6月图268笔，最大单笔6月18日999.00，153笔支出，全范围rankingComplete |
| C1受控非法sort后真实模型纠正 | 2次真实调用；原模型首次tool args在内存注入非法sort，下一次实际供应商收到错误并改monthAsc。真实预览、guard、DTO、268笔与图表通过。不是供应商自然参数错误 |
| 完成审计列宽 | 最新C1请求3e02dab8-f977-418a-aebb-f621deecbc76，grounded-done恰1条实际入库；旧ER_DATA_TOO_LONG/1406/22001警告保留，不追补伪造历史审计 |

全部8回执各两遍HTTP读取、5聊天真实历史/web恢复通过，新增模型调用0；新草稿、业务提案、候选与committed均0。23本人业务表与本轮付费前新基线hash一致。最终证据：acceptance-final.md、live-summary.json、live-audit.json、combined-live-usage.json、final-readback.json、business-before-remaining.json、business-after-remaining.json、observed-audit-warnings.json。API继续现有7788（验收后PID32556）；5173本轮未启动，没有新服务或终端窗口。前端源码无新修改，本轮核SSE解析、DTO、历史恢复与实际图表options，不声称再次完成浏览器视觉验收。

## 范围

未重新命名已有datasetId，避免破坏历史；不实施L1/L3预留授权。工具schema被供应商接受与供应商必然遵守schema是不同结论，服务端校验继续保留。G01..G13中除本轮直接覆盖项以外，不宣称全部解决。

当前30000token规则是每次调用前检查已报告累计量，最后一次调用仍可能越线；真实fresh multi曾4调用累计33043（第4次前27417）。本轮保留现行预算，不把阈值宣称为精确费用硬上限。供应商usage不等于实际账单。

---

## 来源：CHANGELOG_2026-11-09_AI_TOOLSET_HANDOFF.md

# AI 工具清单与全场景测试交接（2026-11-09）

用户要求根目录提供 Markdown，供其他 AI 系统测试当前财务助手工具集。

已新增根目录 `AI_TOOLSET_TEST_HANDOFF.md`，以当前 V3 源码为依据列出8个原生工具、23个查询数据集、15种提案kind、图表/OCR、各参数组合及数据粒度、范围/数量/排名口径、记忆读写与正式业务执行的不同副作用、上下文和预算。

交接包含分层测试方法、既有fixture与命令、覆盖矩阵、用户可见结果与回执验收模板；标明测试脚本遗漏和旧真实验收的破坏性行为。静态发现的13项交叉问题单独列为待复现，未宣称已测通过或已修复。

本轮仅读取源码和核对静态工具枚举，不改业务代码、不跑测试、不调用供应商或数据库、不操作端口与服务。通过UTF-8解码、工具/数据集/kind完整性及文中完整源码路径存在性检查。上轮79套/1787项回归仅作为历史基线注明。

用户当前禁止付费模型、新终端窗口和第二套常驻服务的约束已写入交接；后续真实模型效果评测须在明确授权及预算内开展。
