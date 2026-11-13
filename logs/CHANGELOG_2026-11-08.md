# 2026-11-08 变更日志（合并）

> 本文件由当日独立日志按日期合并，来源见各节标题。

---

## 来源：CHANGELOG_2026-11-08_AI_AMOUNT_EVIDENCE.md

# 2026-11-08 口语多笔记账金额引用与账户续接修复

## 真实失败与原因

用户请求 `9fb89be8-4fb7-43b4-a3b7-e57951027bb5` 返回 `400 AI_AMOUNT_NOT_EXPLICIT`。已通过本人该请求的本地调用日志及会话记录核对，诊断阶段只执行只读 SELECT，没有重新发送聊天。

用户明确说了三笔消费：`30 块 8 毛 2`、`20 块 4 毛`、`123 块 6`，全部用农业银行卡支付。模型识别为 `30.82`、`20.40`、`123.60`；工具阶段的中间响应带金额引用，实际最终 JSON 三笔却全部遗漏 `evidence`。本地结构校验允许 evidence 缺省，之后金额校验拒绝，错误文案把模型遗漏引用归因于用户没报金额。

另外两处连续缺口：金额字面解析没覆盖省略“分”的 `30 块 8 毛 2`；三笔账户不明确时抛出整轮 `AI_PROPOSAL_INCOMPLETE`，无法正常追问。此前验收是收支查询，proposal 为 null，并未覆盖本次“口语三笔消费＋多张同银行账户”的输入形态，不能据此证明记账场景无故障。

## 实际变更

- `v3Evidence.js`：覆盖省略分的口语金额，排除空白后的数量/另一金额。仅对普通 CNY 交易遗漏/null evidence，从真实用户原话的唯一金额来源重建引用；金额字段不改。已有错误引用、同额多处来源、明显查询、账户尾号和日期均不猜。无法恢复时明确说明模型引用缺失。最终化仍不信任中间 assistant 的草稿。
- `pendingTransactions.js`：保存最多三笔已验证的待补充意图、完整原话及可信日期；不保存旧账户/分类引用或执行 ID。最多五条原话、十五分钟有效，已完成/取消以 cleared 标记阻止旧批次复活。唯一尾号可在待补账户问题中选卡，重复尾号、金额或否定表达不授权选卡。
- `v3Service.js`：多笔缺账户正常追问，整组必填项未齐时不保存部分草稿。会话 TASK_INPUT 携带待补交易数量、逐笔缺项及原话证据锚；补卡后仍逐笔走金额/日期/账户/权限/资金守卫。
- `conversations.js`：从最新本人会话元数据恢复待补意图，独立于十条消息展示窗口；过期/清除不回溯旧状态。
- `v3Prompt.js`：版本 `life-assistant-v4.3`；明确最终 JSON 每笔保留 evidence、口语金额示例，以及待补上下文只供明确续接使用。

## 离线实际结果

从失败请求提取三个真实模型响应，去掉身份、随机引用和推理内容，固定回放到实际 V3 服务与预览校验。测试中的 provider 只返回记录包，真实 transport 和真实数据库入口均设为禁止调用。

首次输出：

> 已保留这 3 笔交易：买菜 30.82 元；买鸭肉 20.40 元；超市买生活物品 123.60 元。请确认支付账户（卡片名称或尾号），我再生成草稿。

首次草稿数量为 0。分别补答完整农行卡名、`7476`、`7476那张` 后，离线固定最终响应经服务生成三张 pending 草稿：金额 `30.82 / 20.40 / 123.60`，日期都为 `2026-11-08`，账户为本轮唯一匹配的测试农行卡。未执行正式入账。中间 assistant 编造的 `999.99` 仍被拒绝。

## 验证

- 真实失败包回放：6 项通过。
- 金额、账户、会话恢复、V3 服务与 HTTP 契约针对性回归：8 套、245 项通过。
- 完整默认后端测试：78 套、1625 项通过。
- `git diff --check` 通过。
- 本轮新增真实模型调用 **0**；没有用用户余额做模型复测，没有修改用户正式流水。

证据位于工作区 `temp/ai-amount-failure-20261108/`：`request-evidence.json`（本地只读诊断）、`replay-before.json`（旧现场复现）、`replay-final.json`、`replay-observed-results.json`、`targeted-tests.json`、`api-full-tests.json`。固定脱敏回放包为 `tests/helpers/aiAmountFailureRecorded.json`。

本轮验证证明该已记录失败响应经过修复后的本地服务能正确完成追问与草稿生成；没有重新调用付费模型，不能据此宣称新一轮模型响应已实测成功。

## 后端控制台推理输出（同日追加）

按用户要求，V3 每次供应商响应返回后，将 `reasoning` 与 `reasoning_content` 中实际存在的文本用 `console.log` 打印到启动后端的 PowerShell 窗口。输出带 `[AI reasoning]`、requestId、轮次、阶段和模型；正文保留换行，配置 Key 及已知凭据脱敏。打印发生在后续预算/JSON/金额验证前，因此最终答复被拒时也可查看该轮供应商推理。

该打印不新增文件或数据库日志，不传给前端，不改变调用次数、工具与最终化输入。三套相关离线回归 113 项通过，新增真实模型调用 0。用户正在使用 nodemon 启动后端，代码通过正常监听重载生效。

---

## 来源：CHANGELOG_2026-11-08_AI_CARD_INTERVAL_RANKING.md

# 卡消费参数与跨月累计排名（2026-11-08）

## 实际问题

已有请求的供应商工具参数为 `card-monthlyConsumption`、借记卡、`sort: amountDesc`、`direction: expense`。直接失败原因是 V3 非 finance 方向校验无条件拒绝 `direction`；该数据集的 SQL 本来固定读取支出，金额排序也已支持，能力声明和校验相互冲突。

同时发现卡月消费排序粒度是卡与月份组合，不能以首行回答多个月每张卡累计支出最高。V3 日期解析也遗漏“最近三个月”，导致默认本月与模型自主选择的范围不一致。

## 修复

- `v3Tools.js` 对消费数据集允许支出参数，缺省或 `both` 明确规范为该消费数据集的实际 `expense`；`income` 保持拒绝，并指向收支数据集。其它数据集不放宽方向、排序和卡类型校验。
- 新增消费数据集专用 `groupBy: card/cardMonth`：默认 `cardMonth` 保持月度趋势；`card` 在 SQL 按完整范围逐卡合计，再按金额排序并截取，匹配行数为真实卡片数，流水总笔数独立保留。
- `v3Service.js` 对卡累计第一名选择 `groupBy: card`，按明确用户范围纠正模型日期，并在最终答复中使用经过服务端排序的榜首。月度趋势保持逐月粒度；有未定价消费时限定结论范围。
- 最近 N 个月复用含本月的自然月口径，支持中文与阿拉伯数，2026-11-08 的最近三个月为 2026-09-01 至 2026-11-08。明确滚动或完整月短语不擅自套用该口径。
- 查询元数据及跨轮覆盖信息保留实际支出方向、卡类型和统计粒度；预览严格校验新增字段，只给支持的数据集使用。
- 工具参数失败直接在原控制台打印 `[AI Tool Check]` 字段/规则、`[AI Tool Args]` 供应商参数；规范化前后有差异时显示 `[AI Effective Args]`。沿用脱敏及长度限制，不新增供应商重试，不接入前端或持久诊断载荷。
- 提示词升级 `life-assistant-v4.7`，同步说明消费方向、月度与区间粒度、最近月份口径。

## 验证

- 离线回放：A 卡每月 60 元、三个月累计 180 元，正确超过单月 100 元的 B 卡；只返回一行仍保留全量卡片数与流水数；实际预览通过，模型空答复也能生成真实榜首结论。
- 非法收入参数仍拒绝，打印具体方向规则，仅一次供应商桩调用，无查询或草稿写入；其他不支持方向/分组/排序的数据集仍拒绝。
- 覆盖跨年月份、中文数字、月度趋势、截断、未定价、凭据隐藏和新增元数据白名单。
- `npm test -- --runInBand --silent --verbose=false tests/unit/ai tests/unit/accountIdentityBoundary.test.js tests/integration/ai`：79 套 / 1787 项全部通过。
- 真实账本只读查询与元数据校验通过：上述范围有 2 张借记卡、5 笔支出，最高卡累计 CNY 183.32；无未定价消费，排名完整。
- 5173 首页与 7788 `/api/health` 均 HTTP 200，没有启动新终端窗口或服务。未调用真实供应商模型。

---

## 来源：CHANGELOG_2026-11-08_AI_CARD_RANKING.md

# AI 卡片跨月消费排名失败诊断与修复（2026-11-08）

## 结论

用户问「最近三个月哪张借记卡支出最高」时，模型按 `[AI Say]` 的计划调用 `query_data`，但在工具参数校验阶段被拒，整轮以 `AI_TOOL_ARGUMENT_INVALID` / HTTP 400 终止，**没有进入数据库读取，因此没有得到任何卡片金额**。

失败日志：2026-11-08T15:45:59Z（本地 23:45:59），`/api/v1/ai/v3/chat/stream`，requestId `bc2137ab-c27f-4f0e-abef-54a0a987b68f`，traceId `70299823-439e-4681-a351-c50a78ac3b7e`，conversationId `052af9f1-7519-446a-9130-6669c2b685ce`；`phase=run` → `v3-http`，`providerCalls=1`，`elapsedMs=6294`，`message=此数据集不支持收支方向或金额排序`。

## 根因

1. **直接触发点**：`v3Tools.js` 的旧护栏为 `domain !== 'finance' && (value.direction || value.sort && !白名单)`。`card-monthlyConsumption` 属于 `card` 域，模型为表达「支出」在参数中附带了 `direction: 'expense'`；而 `sort: 'amountDesc'` 原本已在 `['dateDesc','amountDesc','expenseDesc']` 白名单内。粗粒度的 `value.direction` 条件仍把整次调用判为非法，错误文案把「收支方向」与「金额排序」并列，实际只有方向字段越界，具有误导性。记录到的工具参数为：`{datasetId:'card-monthlyConsumption', cardTypes:['debit'], startDate:'2026-08-01', endDate:'2026-11-08', sort:'amountDesc', direction:'expense', limit:5}`。
2. **结果口径错**：即使放行，该数据集默认每行是「一张卡 + 一个月」。按金额降序取第一行得到的是最大单月消费，不是三个月累计最高的卡。离线夹具中借记卡 A 三个月各 60（合计 180）、借记卡 B 单月 100，按月度行排序会错判 B 为最高。
3. **时间口径错**：2026-11-08 的「最近三个月」应为 2026-09-01 至 2026-11-08 三个自然月（含本月部分），`[AI Say]` 计划的 2026-08-01 起覆盖四个自然月。
4. **可观测性缺口**：旧日志只有 `guard.error` 的 code/causeCode，不带具体字段和原始工具参数，无法从日志判断是 direction 还是 sort 被拒。

## 变更（当前工作区已落地）

- `v3Tools.js`：`query_data` 新增 `groupBy: card | cardMonth`（仅 `card-monthlyConsumption`）；该数据集把 `direction` 归一化为 `expense`、显式拒绝 `income`、默认 `cardMonth`；护栏拆成 `badDirection` / `badSort` 按字段判定并附 `validationDiagnostic`；工具描述写明跨月累计第一名必须搭配 `groupBy=card`。
- `v3Service.js`：卡消费任务按用户原话强制 `sort=amountDesc` 与 `groupBy=card`（月度走势不强制），用 `explicitPeriod` 覆盖日期范围；服务端生成区间累计第一名结论（含并列、未定价提示），不依赖模型自行求和；工具参数校验失败打印 `[AI Tool Check]` 字段/规则与 `[AI Tool Args]` 脱敏原文。
- `businessRead.js`：SQL 依 `groupBy` 决定 `GROUP BY a.card_id[, LEFT(trans_date,7)]`，匹配行数与汇总按全范围计算，金额排序在筛选后、LIMIT 之前执行。
- `queryContext.js` / `queryMetadata.js`：「最近 N 个月」按含本月的 N 个自然月至今天解析（跨年、中文数字、滚动/完整月语义不误判）；`queryMeta` 增加 `groupBy`、`filters.cardTypes` 与 `direction` 的校验和保存覆盖。
- `v3Prompt.js`：`life-assistant-v4.6` → `v4.7`，说明该数据集仅支出、方向可省略、`groupBy=card` 与 `cardMonth` 的语义差异及最近 N 个月口径。
- 测试：新增 `aiV3CardRankingReplay.test.js`（记录到的失败参数离线回放）、`aiRecentMonthScope.test.js`、`aiV3CardQueryTool.test.js`，扩充 `aiBusinessRead.test.js`、`aiDiagnostics.test.js`、`aiV3Service.test.js`。

## 验证

- 回放用例：记录参数不再抛错，实际查询为 `groupBy=card`、`cardTypes=['debit']`、`direction='expense'`、`sort='amountDesc'`、`scope=2026-09-01~2026-11-08`；首行借记卡 A `180.00`，`rankingComplete=true`；`limit=1` 时仍给出全范围第一名；月度趋势请求保持 `cardMonth` 行。
- `direction='income'` 仍被拒绝，控制台打印字段 `direction`、规则 `dataset.direction` 与原始参数，失败持久化不含工具参数细节，不重试、不写库、不生成预览。
- `npx jest --runInBand --silent --verbose=false tests/unit/ai tests/unit/accountIdentityBoundary.test.js tests/integration/ai`：**79 套 / 1787 项全部通过**。首次复跑时曾有 1 项瞬时失败（并发编辑中的测试断言），断言收窄后复跑 41 项专项用例全部通过。
- 所有回放用例禁用真实供应商与数据库，未新增付费模型调用；未重启 5173 / 7788 服务。

## 后续

- v4.7 提示词对真实供应商的效果未额外调用验证，建议上线后用真实账号复问一次「最近三个月哪张借记卡支出最高」。
- 若后端仍在运行旧进程，需重启使改动生效；本次未重启。

---

## 来源：CHANGELOG_2026-11-08_AI_CONSOLE_COLOR.md

# 2026-11-08 AI 控制台黄色正文

按用户要求，将供应商返回的思考正文显示为黄色 `[AI Say] 原文`。保留原有 `[AI reasoning]` 请求关联头；仅正文使用 ANSI `33m`，末尾 `0m` 恢复颜色，后续普通日志不会变黄。

实现位于 `src/modules/ai/service/diagnostics.js`。仍沿用已有凭据脱敏与 console-only 输出，不新增前端功能或日志存储，不增加模型调用。

离线验证使用既有 `aiDiagnostics.test.js` 与 `aiV3Service.test.js`，2 套、114 项通过；axios/provider 均为 mock，检查黄色前缀、颜色复位、脱敏和逐轮打印。另用用户提供的英文句子直接调用本地打印函数预览，未请求供应商，未新开终端窗口或服务。

---

## 来源：CHANGELOG_2026-11-08_AI_MEMORY_CONTEXT.md

# 2026-11-08 AI 长期记忆与历史上下文

按用户授权实现 `api/data/memory` 下的 Markdown 长期记忆，允许 AI 根据真实来源自主读取与保存长期偏好、资料、工作方式及备注，并扩展当前聊天历史回查。沿用现有聊天和业务执行链路；本轮没有新增供应商调用，也没有启动新终端窗口或服务。

## 最终数据边界

- 近期原话按预算选择最多 12 个用户轮，默认历史估算预算 3500 tokens，可由 `AI_CONTEXT_HISTORY_TOKENS` 在 500–12000 之间配置。预算估算计入结构化历史及兼容字段的重复文本；超额历史形成最多 8 项带日期、状态的原话摘要，每项最多 320 个 Unicode 字符。该估算不是供应商精确 token 统计，也不表示携带了完整历史。
- 分主体任务 registry 最多保留 6 个任务，避免收支、卡片等任务来回切换时互相覆盖。独立 queryCoverage 最多保留 8 项前轮范围、过滤、匹配数、返回数、源笔数及覆盖状态，新增 incomeCount/expenseCount 方向子数；前轮数量仅解释其来源和口径，不能成为本轮统计金额或查询回执。
- 待补交易保持 15 分钟有效期；原交易最多 3 笔及 3 个原话来源，额外账户、分类或支付补答来源最多固定保留 6 条。携带窗口最多 16 个用户原话来源，并重新映射 sourceTurn，避免后续历史裁剪丢失有效账户补答；过期、明确取消或不适用的待补状态仍不得复活旧交易。
- `history_search` 以字面关键词查询当前用户、当前聊天的历史消息，SQL 绑定 owner 和 conversation，并转义 LIKE 的 `%`、`_`；`history_read` 只接受本轮返回的 `h_ref`。历史 assistant 回复、旧候选引用和摘要不能替代本轮金额原话证据。
- 持久记忆保存在 `data/memory/SHA-256(userId)/文件.md`。目录由真实写入创建，普通聊天读取、列出和搜索不会制造空目录。类型为 `preference`、`profile`、`workflow`、`note`；文件前置 title/type/created/updated/source 元信息，正文可由人类编辑。
- `memory_write` 必须逐字引用真实用户原话；当前轮来源或本轮历史工具读回的 user 原话均须服务端验证。模型应自行判断内容是否适合长期记忆。存储层能检查 UTF-8、Unicode、结构和敏感字段，不能用正则证明中文或英文语法正确，也不能证明任意记忆内容具有长期性。
- 所有记忆和历史工具读取结果标记为 untrusted。记忆不能改变系统、工具、授权规则，不能成为交易金额、日期或账户授权的来源；业务写入仍经既有草稿、原话校验及人工确认链路。

## Markdown 存储与安全审阅

主要实现为 `src/modules/ai/service/memoryStore.js` 与 `memoryRegexWorker.js`，说明文件为 `data/memory/README.md`。

- 路径只接受单层、短、相对 `.md` 文件名，拒绝路径穿越、绝对路径、Windows ADS、设备名、符号链接、junction 和硬链接。目录逐层检查，并核实 realpath；文件读取核实 lstat、已打开句柄及读后身份，不把链接目标内容交给模型。
- 文件以 fatal UTF-8 解码；不悄悄替换损坏字节。拒绝替换字符、不配对代理项、控制与隐藏字符、BOM 及常见乱码模式；正常中文、English、Markdown 代码、普通数字日期、银行名称和安全尾号均可保存。密钥、完整号码、内部 UUID、`r_`/`q_`/`h_` 历史引用拒绝落盘。
- 每用户最多 50 个文件、总计 1 MiB，每文件最多 64 KiB。写入按用户串行，先同目录独占创建临时 `.md`，写入并 sync 后原子 rename；覆盖或 patch 要求最新 SHA-256 revision，写前再次检查人工编辑。重复追加同一片段不再次写入；空 patch 可删除一个唯一原片段，但不得删除全部正文。
- 列出与搜索按文件隔离损坏文件，返回 warnings，其他合法记忆继续可读；直接读取坏文件仍报明确错误，不能自动覆盖坏文件。容量统计包含坏文件。工具输出额外限制列表、正文分页和告警数量，避免把整个记忆目录一次塞给模型。
- 字面和正则搜索按正文行返回有界片段；正则只在资源受限的 worker 中执行，500 毫秒超时终止。搜索与分页按 Unicode codepoint 截断，避免切半代理项。
- `.gitignore` 只放行 `data/memory/README.md`；用户哈希目录、运行时记忆和其余原有 data 内容继续忽略。没有执行 Git 提交，也没有提交用户记忆。

## 保存回执与答复校正

`memoryClaims.js` 导出 `reconcileMemoryClaims(answer, { receipts, errors })`，返回校正后的 answer、供既有业务声明检查使用的 businessClaimsText 及 corrected 标记。

没有服务实际保存产生的 saved 回执时，“已记住”“已保存到记忆”及 English saved/remembered 等完成声明被校正为本轮未保存；失败原因直接展示，并对路径、密钥、内部引用及长文本再次脱敏和限长。此类记忆错误作为工具结果处理，避免整轮聊天因记忆失败返回 400。

有真实回执时允许对应的记忆保存/更新措辞。业务检查只排除明确记忆动作的片段，并保留共享完成标记；例如“已更新答复偏好并修改账本”仍保留“已…修改账本”的业务声明，不会因为一个记忆回执绕过入账或修改检查。否定、未来计划、引用示例和明确以前的记忆不当作本轮保存声明。

真实 saved 回执与当前泛指记忆的“没有保存”措辞冲突时，校正为本轮已保存。历史或条件否定、引用示例、其他路径或版本、冲突及本轮工具错误不强行改为成功；重复追加未发生变化时，也不把“没有更新”强改为已更新。

这项校正属于有限语言检查，不能证明任意自然语言中的所有断言为真；混合多文件保存结果、任意中文及英文业务执行措辞仍需沿用真实工具结果与业务回执核验。

## 验证与证据

存储与记忆声明专项离线测试当前 **2 套、103 项全部通过**：存储 52 项，声明 51 项。文件是真实临时目录的 UTF-8 落盘读回；覆盖 owner 隔离、路径攻击、编码损坏、secret/ref 拒绝、人工编辑与并发 revision 冲突、追加幂等、patch 删除片段、字面/正则搜索、ReDoS 超时、junction/硬链接、坏文件隔离、只读无目录副作用、容量限制、Unicode 截断、保存声明正反校正、失败原因安全展示及业务声明不得被记忆回执豁免。

本机普通文件 symlink 创建被 Windows `EPERM` 拒绝，未把该项声称为真实文件 symlink 实测；目录 junction 和硬链接已实际创建并验证拒绝，文件链接的 lstat/O_NOFOLLOW/句柄校验同时经过源码审阅。

命令通过隐藏的既有 Node 运行时执行 Jest，不启动新终端窗口，不请求供应商：

```text
node node_modules/jest/bin/jest.js tests/unit/aiMemoryClaims.test.js tests/unit/aiMemoryStore.test.js --runInBand --silent --json --outputFile=D:/Code/live/temp/ai-amount-failure-20261108/memory-store-claims-tests.json
```

实际执行目录为 `D:/Code/live/api`，脚本路径为该目录的 `node_modules/jest/bin/jest.js`。证据：`D:/Code/live/temp/ai-amount-failure-20261108/memory-store-claims-tests.json`。Git 只读检查确认记忆 README 不忽略（check-ignore exit 1），用户记忆和原有 data/uploads 仍忽略（exit 0）。

最终 API 全量回归 **97 套、2041 项全部通过**，包括既有金额、日期、权限、原话、草稿确认及 HTTP 合同边界。前端 AI 回归 **124 项全部通过**，`Assistant.vue` 的实际 Vue script/template 编译通过。全量证据为 `D:/Code/live/temp/ai-amount-failure-20261108/memory-full-regression.json`。

真实临时文件的服务回放 **24 项通过**：聊天 A 保存、独立聊天 B 列表及正文读取；中文/English、Unicode 分页、字面/正则搜索、版本冲突、重复写幂等、写后重新读、伪造或 assistant 来源拒绝、用户隔离、凭据与内部标识拒绝、坏工具参数正常错误、记忆不能成为交易金额依据，以及实际保存与答复正反声明一致。额外验证人工文件名含已知凭据时，从目录/搜索中隔离并拒绝直接读取，健康文件仍可使用。脱敏效果为 `D:/Code/live/temp/ai-amount-failure-20261108/memory-effect-replay.json`，所有临时用户记忆目录已清理。

实际服务上下文回放 **6 项通过**：六轮闲聊后恢复数量饼图、多主体任务恢复、卡数量覆盖及预算省略中间账户更正时仍拒绝旧借记卡并选择信用卡；泛指“给我柱状图”优先承接最近的卡片任务与分母，不受旧收支范围干扰。方向数量服务回放 **2 项通过**：一行月度汇总的总笔数与收入/支出子笔数独立携带，未知保持 null；已知数量来自本轮 summary，历史范围/source/asOf仍明确。方向数量示例使用测试夹具，不能当用户账本实数。

金额来源隔离服务回放 **3 项通过**：扩大历史窗口后，新交易缺少模型 evidence 时只从当前原话恢复，待补交易只从固定原始来源恢复，十笔历史同价消费不会制造错误歧义；同一句确实有两笔相同金额且缺少区分证据时仍拒绝默合成单笔。独立工具/路由回放全部使用受控假 provider，没有调用真实 DS 或商汤，也没有请求真实业务数据库。

运行环境检查发现原 5173 Vite 进程仍监听但 HTTP 超时；只停止已核实属于本工作区的该进程，在后台普通管道中替换同一 5173 服务（strictPort），没有创建终端窗口或增加服务端口。7788 进程保留。最终只读 GET 检查：5173 首页与 7788 `/api/health` 均返回 200，没有发送真实 AI chat 请求。

前端同步修复恢复对话时空答复的安全重试入口，并为记忆和历史 trace 使用对应标签。根代理已验证 **124 项前端测试通过**，`Assistant` Vue SFC 实际编译通过；这不表示调用了用户的付费模型。

## 生效范围

源码修改位于当前本地 API 工作区；无需新数据库表或迁移。上线环境仍需发布并重新加载更新后的 API，本轮未部署。Markdown 记忆保存在服务实例本地磁盘，mutex 是进程内串行机制，不是多个进程或多台主机的分布式锁；恶意外部进程在文件系统检查与 rename 之间主动竞态、跨实例共享目录的协调，不宣称由本次便携 Node 文件接口完全消除。

---

## 来源：CHANGELOG_2026-11-08_AI_QUERY_CONTEXT.md

# 财务助手查询上下文、范围及数量修复（2026-11-08）

本次按用户要求修改代码并测试实际效果。修复了月份与分类追问丢失、分类预览白名单缺列、截取后筛选遗漏月初流水、最大单笔和最大支出日无法确认、结果数量混淆的问题。既有工作区改动保留。

## 最终行为

- 查询意图单独保留期间、收支方向、分类、统计目标与成功／失败状态。明确换月收支时清除旧购汇限制；“某月呢”承接同一主体；“最大的一笔”承接上一查询期间。历史 user／assistant 按 turnId 绑定，页面重新加载和服务重启后仍可恢复。
- `queryContext.lastResults` 最多携带 4 项前轮范围、过滤、匹配数、返回数、源流水数、覆盖状态及查询时间，并明确标记为 previous-turn。旧金额、旧流水、旧 ref 不进入这项上下文，旧数量也不能成为当前统计证据。失败与未知数量不记作零。
- 财务查询先在 SQL 中完成同一范围和过滤，再统计、排序、截取。月度、分类、每日汇总、明细使用同一只读一致性快照；最大单笔按有效冻结人民币金额降序，最大支出日按全日支出汇总降序。
- 每次查询拥有 queryId 和 queryMeta；同名数据集的不同查询不互相覆盖。图表绑定具体查询实例及其实际范围。
- 区分匹配结果行数、返回行数、源流水笔数、收入笔数、支出笔数；月汇总 1 行表示 1 个月，分类行数表示分组数。分别保留明细、汇总、排名覆盖状态，未定价金额仍不能证明全范围最大值。
- 分类首末日期列通过分析预览白名单，但不拿首末日期推断最大单笔发生日。最终化输入清除未验证的中间 assistant 正文；数值按当前数据核对，笔数另外验证来源与单位。
- 查询用收支明细只投影公开列，去掉不必要的三个身份引用，使常规 50 条结果在原有 16 KiB 外发上限内返回。候选提案仍通过 list_choices 获取当轮引用。明细表不会把 direction 编码写成总笔数；查看其余记录的提示使用缩小日期范围。

主要实现：`src/modules/ai/service/queryContext.js`、`queryMetadata.js`、`queryCountClaims.js`、`financeDatasetRead.js`、`businessRead.js`、`conversations.js`、`analysisPreviews.js`、`v3Service.js`、`v3Tools.js`、`v3Schema.js`、`v3Prompt.js`。Web 同步更新查询契约、数据卡范围和数量显示、查询实例及图表绑定。提示版本为 life-assistant-v4.2，提示 digest 与独立工具／输出契约 digest 一同记录。

## 实际验收

使用本项目真实 app 路由、真实 MySQL、真实 SenseNova 模型和真实 Web 页面；不是模拟回复。验收在隔离合成库 `ai_fullscene_20261107_dcd7fbe5` 中新增测试身份及 520 条流水，未使用用户账本流水。下面的金额和日期是验收基线，不能当成用户实际账本答案。

| 实际提问／检查 | 实际结果 |
| --- | --- |
| 5 月购汇最大单笔是哪一天 | 5 月 2 日，CNY 1800.00；月初两笔购汇均可见，合计 CNY 3000.00 |
| 花得最多是哪一天，在 5 月 | 5 月 2 日，CNY 1800.00；购汇过滤已清除，覆盖全月 152 笔支出 |
| 6 月支出和收入，给图表 | 支出 CNY 7150.00、收入 CNY 5000.00；268 笔＝168 笔支出＋100 笔收入，柱状图真实渲染 |
| 紧接着问“支出最大的一笔是？” | 仍查询 6 月，6 月 1 日购物 CNY 2500.00，按全范围金额排名 |
| 重新加载页面后问“支出最多的是哪一天？” | 仍查询 6 月，6 月 5 日 CNY 3000.00；没有把最大单笔当作最大支出日 |
| 展示 6 月 50 条明细 | 实际匹配 268 笔、返回 50 笔，汇总覆盖全月；日期窗口没有全量排名结论 |

真实 SQL 验收覆盖四种财务数据集、7 次查询和 18 条 SELECT，并另用原表 SQL 校对基线。四轮连续模型验收全部通过；持久化数量按 2 → 152 → 268 → 168 切换，三个下一轮输入的 previousQueryCoverage 带准确前轮范围、数量、turnId 和 asOf。页面中额外实际发送了最大支出日、50 条明细和图表请求，并保留截图与 provider 审计。

验收中发现并修复了两处模拟测试未暴露的故障：MySQL 不接受聚合别名参与 `ORDER BY ... IS NULL` 表达式，现直接降序且 NULL 自然排后；50 条明细曾超出外发上限 191 字节，现通过去掉无用身份引用解决，上限未放宽。初次错误证据和复测证据分别保留。

## 验证结果与证据

- API 全量：74 suites、1541 tests 全部通过。命令为 `node node_modules/jest/bin/jest.js --runInBand --cacheDirectory D:/Code/live/temp/ai-query-context-20261108/jest-full-cache --json --outputFile D:/Code/live/temp/ai-query-context-20261108/api-final-full-tests.json --silent`。
- Web 全量选定清单：138 项、137 通过。唯一失败是既有 `tests/uiSafety.test.mjs:23` 的非演示登录默认值检查，本轮未改登录页；全部 AI 查询用例通过。后续契约校验 24／24 通过，7 份真实财务元数据均通过 Web 契约。
- Web 生产构建通过，输出到 `D:/Code/live/temp/ai-query-context-20261108/web-build`。API 与 Web 的 diff whitespace 检查通过。
- 最后一次实际 Web 请求使用最终代码启动 manifest；较早的主序列和图表证据保留各自版本来源。最后追加的修改只调整无分页能力时的查看指引，已全量回归并实际复验 50 条明细。
- 页面证据核对 47／47 通过，最终启动 manifest 的 11 个源码文件均与磁盘一致。最后 50 条实际 tool payload 为 9525 字节，queryMeta 保留完整；实际请求成功、原生工具与最终化、前轮覆盖来源、当前汇总和图表绑定均已逐项核验。收集器自身只读合成库，没有新增模型调用。

全部临时脚本、缓存和原始证据位于 `D:/Code/live/temp/ai-query-context-20261108/`。可查：

- `finance-real-results.json`、`finance-source-baseline.json`、`finance-sql-evidence.json`：真实 SQL 与独立基线。
- `provider-final-sequence.json`、`provider-final-audit.json`、`provider-final-context-proof.json`：连续真实模型与持久化上下文。
- `provider-final-details.json`：50 条独立复测。
- `ui-acceptance-summary.json`、`ui-final-evidence.json`：最后页面请求、实际模型调用、覆盖数量和代码版本核对。
- `ui-june-max-day.jpg`、`ui-june-chart.jpg`、`ui-june-fifty-details-final.jpg`：实际页面截图。
- `api-final-full-tests.json`、`frontend-summary.json`：测试统计；完整前端失败输出包含既有登录源码，不用于对外报告。

## 生效范围

修改已落在当前本地 API 与 Web 源码，实际页面验收使用 loopback 7793／5178。线上应用需要发布 Web 构建并重启更新后的 API 才会生效，本次没有部署线上环境。无需数据库迁移；上下文保存在现有消息 meta 中。任意自然语言与多范围数量归属不宣称全面识别，未定价记录不宣称完整最大值，日收入最大值未列入本轮验收。

---

## 来源：CHANGELOG_2026-11-08_AI_REASONING_QUALITY.md

# 财务助手任务承接与分析结果修复

日期：2026-11-08。用户授权修复并测试；本轮禁止调用付费供应商，只使用保存的真实响应和离线 mock。沿用 5173/7788，不启动额外服务或终端窗口。

## 最终行为

- 上轮要求借记卡/信用卡饼图，本轮更正为已有卡片数量：保留饼图意图，查询规范到 `card-counts`，仅两类参与分母。保存的真实响应经过实际服务流程后，信用卡 20、借记卡 59、合计 79、占比 25.3%/74.7% 均保留，图只含两类。
- 按用户轮次携带原话、日期、对应答复和失败状态；独立卡片动作不挤占最近四轮对话。任务口径、图表要求和查询覆盖数量分别保存，旧结果仅用于承接，本轮仍重新读取。
- 自然“6月支出比5月多多少”允许独立月份查询。两个完整且同口径的已授权月份结果能在后续预览中发布差额和变化比例；示例 6 月比 5 月少 860.12 元、下降 12.9%，6 月净支出 1873.37 元，最终文字通过对账。
- 净收支、分类占比和卡数量占比由可信数据派生后进入相同预览授权及字段白名单。金额计算使用整数分；混币、未定价、未知或不完整金额不发布确定派生统计。分类实际 `direction/amountCNY` 数据也支持同方向占比。
- 分类按收支方向筛选；账户候选携带银行、卡类型和安全尾号。银行与卡类型在完整本人候选中唯一时可以选择，最新否定或更正优先于旧原话。
- 待补记账使用非执行 `clarification.items`，与草稿协议互斥。逐笔金额仍必须引用用户原话。三笔续接只返回一笔时不创建部分草稿、不清空整批；合法宽窄金额引用可承接原三笔，重复及含糊同金额引用仍拒绝。
- 草稿状态通过本人专用轻量方法读取，不调用财务预检；只在必要任务且财务授权通过后携带。已提交状态与待核对状态分开，闲聊不读取旧草稿，不自动复活旧记账。
- 日期补充不能来自金额原话之前的无关轮次。已证明全范围最大时剔除“可能还有更大”的不实免责声明，同时保留有依据的解释。
- 提示词升级 `life-assistant-v4.4`，明确任务、证据、分析与输出协议，允许必要补查，保留金额/引用/权限/用户确认限制。控制台供应商推理打印沿用，不增加日志存储或调用。

## 验证与实际渲染

最终 API 默认回归 **85 套 / 1778 项全部通过**（`quality-full-final.json`）；前端现有 AI 测试 **123 项全部通过**（`quality-web-tests.txt`）。8 项服务质量回放全部通过（`quality-final-replay.json`）。报告保存在工作区 `temp/ai-amount-failure-20261108/`。

真实响应脱敏 fixture：`tests/fixtures/aiV3ReasoningQuality.json`；服务回放：`tests/unit/aiV3ReasoningQualityReplay.test.js`。测试硬 mock 真实数据库与供应商 transport，断言调用数为 0。

`temp/ai-query-context-20261108/quality-replay-final.json` 是实际服务回放的最终文字/图数据；`render-quality.cjs` 编译现有 `web/src/components/ai/AiChart.vue`，用真实 ECharts SVG 表面校验两个扇区，产出 `quality-render.html`、`quality-pie.svg` 和 `quality-render-check.json`。未启动浏览器服务或测试服务器。该渲染检查不代替付费模型的新生成验收；本轮没有调用付费模型。

服务检查：5173 返回 HTTP 200，7788 的 `/api/health` 返回 `ok`；前端进程保持原有实例，后端随现有 nodemon 重载。没有启动额外服务或端口。

## 主要文件

`v3Service.js`、`v3Prompt.js`、`v3Schema.js`、`taskContext.js`、`historyContext.js`、`queryContext.js`、`pendingTransactions.js`、`candidateSelection.js`、`analysisFacts.js`、`draftContext.js`、`analysisPreviews.js`、`v3Tools.js`、`businessRead.js`、`conversations.js`、`index.js` 及对应离线回归。

保留工作区已有改动，未提交或重置仓库，未调用真实账本写入接口。

---

## 来源：CHANGELOG_2026-11-08_AI_VALIDATION_CONSOLE.md

# AI 返回格式校验诊断（2026-11-08）

## 问题与原因

前端收到 `AI_INVALID_RESULT` 时只能显示通用格式错误。原控制台打印供应商 reasoning 正文和通用错误，但没有最终正文与 Joi 字段检查结果。

本次已有供应商返回的 JSON 缺少必填顶层 `answer`，同时包含未开放的 `clarification.question`。校验分别命中 `any.required` 和 `object.unknown`；不是 JSON 语法或金额精度问题。问题应放在顶层 `answer`，`clarification` 仅允许 `items`。

## 变更

- `v3Schema.js` 保留原校验与错误行为，增加非枚举 `validationDiagnostic`，包含阶段、字段路径、规则、固定中文解释和实际类型；最多 20 项，不携带 Joi 原值。
- `diagnostics.js` 新增 `[AI Check]` 和 `[AI Result]` 临时控制台输出，关联 request/trace/conversation、模型与轮次。JSON、响应格式和后续协议错误可区分阶段，正文脱敏并限制为 12000 个 Unicode 字符；无效 JSON 的凭据字段也会隐藏，console 故障不覆盖原错误。
- `v3Service.js` 在最终解析、校验以及后续格式错误处打印一次诊断，原错误继续传播；不修补错误 JSON、不新增供应商重试。
- 提示词升级为 `life-assistant-v4.6`，明确 `answer` 必填、澄清问题所在字段及已入账更正边界。已入账流水应引导在原流水核对编辑，不能新建同笔或差额草稿代替修改。
- 新诊断直接输出 console，不接入前端、恢复回执、历史或持久诊断日志。既有按用户设置记录供应商调用的功能保持原行为。

## 验证

- 实际失败 JSON 离线回放准确打印上述两处字段错误与脱敏正文，仍拒绝返回，不产生草稿/流水写入。
- 单元测试覆盖字段诊断、非枚举隔离、互斥协议、解析与响应格式阶段、凭据隐藏、中文/English、Unicode 截断及 console 异常。
- `npm test -- --runInBand --silent --verbose=false tests/unit/ai tests/unit/accountIdentityBoundary.test.js tests/integration/ai`：76 套 / 1723 项全部通过。
- 5173 首页与 7788 `/api/health` 均 HTTP 200；没有启动新终端窗口或服务。
- 全程未调用真实供应商模型。提示词调整的真实供应商效果未额外调用验证；离线测试已确认诊断链路与拒绝行为。
