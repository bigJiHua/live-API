# Golden Finance API — 生活管理系统后端

> **接手启动与 env 配置**：先看 [ENV_SETUP.md](ENV_SETUP.md)。提交的 `.env.example` 默认与 Web 配套为 API `7788` / Web `5173`；真实 `.env` 不入库。运行 `npm run env:check -- --db` 检查配置及数据库连接，启动也会自动检查配置。

> **更新日期**：2026-11-13（目录、路由、命令及归档引用已按当前文件核对）

## 快速导航

[功能特性](#功能特性) · [项目结构](#项目结构) · [API 路由总览](#api-路由总览) · [快速开始](#快速开始) · [运行测试](#运行测试) · [系统初始化](#系统初始化机制) · [更新日志](#更新日志)

| 入口 | 用途 |
|---|---|
| [环境配置](ENV_SETUP.md) | 首次启动、配置检查、端口及 Web/反代对齐 |
| [数据库说明](mysql/README.md) | 完整结构、增量迁移与 AI 同库只读授权 |
| [AI 模块说明](src/modules/ai/README.md) | V3 聊天、工具、授权、额度与个性化接口 |
| [测试说明](tests/README.md) / [黄金评测](tests/eval/README.md) | 默认离线测试与真实供应商评测边界 |
| [Mock 数据工具](tools/mock/README.md) | 独立模拟库的生成、校验与使用 |
| [AI 试行手册](../Docs/docs/ai/trial-runbook.md) | 灰度接入、记忆/个性化配套备份与恢复 |

### 当前状态摘要

- **服务与目录**：Node/Express 服务入口为根目录 `app.js`，业务路由为 `/api/v1`；`/api/health` 为不查库的公开探活，静态文件为 `/api/public`。20 个业务模块、23 个路由组；实际目录与工具入口见下方。
- **AI 当前主流程**：文字聊天统一走 `/api/v1/ai/v3/chat` 或 `/v3/chat/stream`；旧 `/chat`、`/ocr`、`/v2/*` 已退役。受控查询、确定性计算、草稿/提案、联网搜索、长期记忆和用户画像均有独立边界，业务正式写入仍须人工确认。
- **配置**：`AI_MODE=disabled` 可先启动基础服务；开启 AI 需同库独立只读 `AI_DB_*`，用户连接在设置页加密保存。额度及超时优先级为本人设置 > `ai_config` > env > 代码缺省，不能把模板回退值当当前站点实际预算。
- **阶段记录**：2026-11-13 第一阶段阶段性收尾，既有独立记录为 API 232 套/5266 项、Web 501 项、隔离真库 10 项及商汤定向 8/8。此处引用已有验收，不是本次文档更新重新测试；搜索真源、生产开闸、其他供应商及全量黄金集不在该结论范围。详见 [当日变更](logs/CHANGELOG_2026-11-13.md#第一阶段阶段性收尾与独立校验) 与 [阶段收尾证据](../temp/api-logs-archive/ai-stage1-closeout-20261113/STAGE1_CLOSEOUT.md)。

## 历史交接与验收索引

以下按各轮当时的版本与范围保留，旧失败、测试计数、运行库及待办状态不代表当前结论；当前使用以目录、配置说明和上述最新阶段记录为准。

> **AI 画像实机修复（2026-11-13）**：修复 30 秒硬截止与兼容网关思考耗尽输出，同步容量、冷却和有界重建游标。72 条合成历史约 3.5 秒生成 6 项，原话及持久化通过；API 228 套 / 5227 项、Web 451 项及构建通过。本地 5173／7788 已加载；远端部署、完整登录握手及手机界面未验收，无新增权限。证据及本轮 5 次真实调用见[最终记录](logs/CHANGELOG_2026-11-13.md#ai-画像实机修复与最终验收)与[模块说明](src/modules/ai/README.md#记忆用户画像与自定义规则)。

> **AI 重启恢复衔接（2026-11-13）**：连接波动后只读核对原回执，覆盖进程租约；强杀遗留轮次按本人活动原话与原请求摘要补齐失败历史，使原问题可继续重试。回执读取独立于模型配置暖机，挂起查询可超时释放，晚到旧流不覆盖新状态。详见[当日变更](logs/CHANGELOG_2026-11-13.md#ai-后端波动与重启恢复)。

> **WebSearch 授权协议修复（2026-11-13）**：联网授权保存响应补齐 `grantedAt`，会话读回补齐顶层有效期及时间字段，兼容已有 web-only 记录；同意后可继续原问题，刷新后授权可正常识别。详见[当日变更](logs/CHANGELOG_2026-11-13.md#websearch-授权响应协议修复)。

> **AI 个性化（2026-11-13）**：聊天设置新增「AI 个性化」，可维护长期记忆、查看并修正 AI 用户画像、定义回答规则。后续聊天携带启用的规则与可用个性化资料；支持记忆历史恢复、画像原话来源及自动增量整理。详见[当日变更](logs/CHANGELOG_2026-11-13.md)与[模块说明](src/modules/ai/README.md)。

> **待补记账恢复与账户纠正（2026-11-12）**：待补任务增加稳定编号和版本；前端可选择账户并通过本地核验成稿，过期后明确点击继续补充。恢复复用同一候选，已有草稿返回原卡；原金额和日期保持核验，任务结束或被替换时拒绝旧卡操作。新增待补读取及恢复接口，详见[当日变更](logs/CHANGELOG_2026-11-12.md)。

> **思考正文实时显示（2026-11-12，用户追加）**：新增 provider reasoning→累计脱敏快照→SSE `reasoning_delta`→默认展开显示的完整链路，前端在模型回复结束前即可看见思考文本；保留尚未最终核验标记、停止／重试身份保护及终态核验替换。原正文渐进UX继续保留。后端4960项、前端414项及构建通过。见[当日变更](logs/CHANGELOG_2026-11-12.md)与[聊天显示说明](../web/src/views/AI/assistant/README.md)。

> **AI 思考流与渐进回复（2026-11-12）**：新增实时思考阶段和耗时事件，前端提前显示思考状态；结果正文逐渐展开，可立即显示全部，历史不重播，向上阅读停止自动跟随。完整回执和正文及时保存，思考详情继续核验后发布。后端4933项、前端397项测试通过，实际消息组件页面验证通过。详见 [当日变更](logs/CHANGELOG_2026-11-12.md) 与 [聊天显示边界](../web/src/views/AI/assistant/README.md)。

> **AI 大范围数据能力（2026-11-12）**：`query_data` 保留十年以内完整日期，新增月／年聚合及签名明细续查，不再裁成最近一年；SQL 全范围计算摘要、资产选择期末保存快照，AI 处理受控摘要与展示页。三年 mock 真库读取、前后页及聚合金额核对已通过；工具与前端同步支持实际粒度和覆盖状态。使用与验证见 [AI 大范围查询](src/modules/ai/README.md#大范围查询) 和 [当日变更](logs/CHANGELOG_2026-11-12.md)。

> **AI数字证据门已修（2026-11-12）**：chat/analysis取账本后校验实际数据与calculate来源，阻止净资产错算/假设洗白；一次有限纠正与安全事实回退，不增加工具或模型预算。分期零计数误判、总期数不能当剩余期数、空/伪工具正文已修。最新实跑8例7通过，唯一分期失败已用捕获原文及真实快照复核通过（未再次付费），历史失败报告保留。详见 [最终修复证据](logs/CHANGELOG_2026-11-12.md)。搜索真源配置、生产及D仍待独立条件。

> **交接真实质量门（2026-11-12）**：最终默认离线211套/4817项通过；隔离SQL种子通过，真实商汤同8例两轮未通过。模型无calculate却把净资产真值误写为偏高的假设值，另有工具参数/回执声明失败。种子工程完成不等于live质量验收完成；搜索源未配置，生产/D未推进。原“零数字泄漏”与“无必须处理技术债”结论不能沿用。详见 [两轮证据和续接](logs/CHANGELOG_2026-11-12.md)。

> **AI交接接手审计（2026-11-12）**：live补种子七数据集已过真实SQL回读；web_search自建执行器已实施（仅chat、脱敏、轮内2次、有界当日缓存、ai_config跨进程原子日额度、安全来源引用、不进账本证据）。修复读取已保存记忆误判写操作及eval未入默认回归/数字substring误放行。当前未配AI_SEARCH_*，真搜索源验收待配置；D和生产计划已纠正危险引用、仍按门槛执行。见 [接手审计记录](logs/CHANGELOG_2026-11-12.md)、[搜索计划](../temp/ALL_PLAN_md/PLAN_AI_WEB_SEARCH.md)、[D计划](../temp/ALL_PLAN_md/PLAN_AI_PROACTIVE.md)、[生产计划](../temp/ALL_PLAN_md/PLAN_AI_PROD_ROLLOUT.md) 和 [总计划§11](../temp/ALL_PLAN_md/PLAN_AI_AGENT_CAPABILITIES.md#11-live-评测种子补齐2026-11-12-立项--小项建议最先跑)。

> **三年单用户 Mock 数据库（2026-11-12）**：当前 API 已切到独立 `live_mock_20261112`（仍用端口7788），覆盖2023-11-12至2026-11-12的42表结构及13038条业务模拟数据。AI会话/消息/草稿/审计历史已清空，原库5个接入商地址、模型、加密Key及生效项迁移到mock_life。HTTP登录、PIN、账务、配置及空会话检查通过。生成器默认不再生成AI历史。使用方法见 [生成工具](tools/mock/README.md)、[本次数据包](../temp/mock-databases/live_mock_20261112/README.md) 和 [变更记录](logs/CHANGELOG_2026-11-12.md)。

> **AI 失败气泡位置修复（2026-11-12）**：迟到的错误与回执固定更新原请求，按发送时序保持用户原话和回复相邻；刷新 journal、显式续跑及跨端历史采用同一锚点。后端保存原请求时间，消息 ID 继续仅作增量游标。无需数据库结构迁移。见 [变更与验证](logs/CHANGELOG_2026-11-12.md)。

> **AI 正文图表与业务 chart 并存（2026-11-12，追加172纠偏，v4.26）**：Markdown `mermaid` 围栏支持七种结构图及 `xychart(-beta)` / `pie`，正文柱状/折线/饼图标注“AI 正文图表”；业务 chart 继续绑定真实取数、服务端重建标题并 fail-closed 校验，open 模式仍纯文本 finalize。正文图表用 `mermaid@10.9.3` strict 配置，移除配置指令后经 `sanitizeMermaidSvg` 消毒。原“禁止正文数据图”已被本轮用户要求覆盖；相关测试215/215、真实模型回复及350px组件页面验收通过，web生产构建成功；全量基线仍有API 7项/web 5项失败。证据见 [当日变更记录](logs/CHANGELOG_2026-11-12.md) 与 [PLAN §9](../temp/ALL_PLAN_md/PLAN_AI_CHART_ALL_MODES_MERMAID.md#9-本轮纠偏markdown-正文数值图与业务-chart-并存2026-11-12)。

> **AI 本轮意图与话题隔离（2026-11-12）**：修复保存图表偏好、询问工具能力及反馈误恢复旧查询；显式新话题保存断点，任务/日期/图表/待补意图恢复不跨界。混合查询保留记忆实际回执，历史增加有界工具事实摘要。无需数据库结构迁移。详见 [变更与验证](logs/CHANGELOG_2026-11-12.md)。

> **归档移入 temp（2026-11-11）**：本次挑出的归档与备份已整体移到 temp/ai-v1-v2-cleanup-20261111/archive，28 个脚本及 ZIP 指纹一致。后续 ignore 扩展及取消跟踪操作已按用户要求撤回，原 ignore 与 Git 跟踪状态已恢复。见 [变更及撤回记录](logs/CHANGELOG_2026-11-11.md)。

> **V1/V2 遗留安全清理完成（2026-11-11）**：28 个旧脚本归档并保留原字节，移除 3 个旧真实验收命令；生产源码移除 V1/V2 旧聊天编排、旧范围文件、无引用授权弹窗和 7 个前端方法。历史回归使用显式隔离夹具，共享执行继续测试当前生产实现。V3、OCR、历史恢复、草稿/提案与迁移能力保留；API **217 套 / 4846 项**、Web **350 项**及构建通过。全部原文件可按 manifest 从 before.zip 恢复。见 [清理记录](logs/CHANGELOG_2026-11-11.md) 与 [temp 归档、备份及精确清单](../temp/ai-v1-v2-cleanup-20261111/archive/README.md)。

> **V1/V2 迁移 V3 后遗留盘点（2026-11-11）**：旧 HTTP 入口已退役，V1 run、V2 preview/chat/cancelPreview、部分未引用前端组件/方法仍保留；13 个工具脚本直接请求 V2，3 个 npm 真实验收入口仍验证旧编排或混合旧聊天步骤。已区分 V3 仍需保留的 OCR、历史兼容与共享执行能力；旧九场景真库套件已 `.skip` 留档。离线路由定向验证 2/2 通过，本轮仅审计文档，未删除生产代码。见 [完整清单](../temp/api-logs-archive/REVIEW_2026-11-11_AI_V1_V2_LEFTOVERS.md) 与 [盘点日记](logs/CHANGELOG_2026-11-11.md)。

> **AI 业务核对卡片恢复收口（2026-11-11）**：恢复模块化时遗漏的日记提案、交易草稿、OCR 与财务核验卡及事件接线；修复候选迟到覆盖和退出会话旧锁，草稿数量回答改以当前会话真实存档为准。用户已看到卡片并成功提交，只读记录确认李白日记与买菜 20 元均 committed。最终 API **215 套 / 4833 项**、Web **342 项**及构建通过，725 份相关源码与 fixture 指纹稳定。见 [修复、实测证据与最终验证](logs/CHANGELOG_2026-11-11.md)。

> **手机 AI 传输与恢复修复收口（2026-11-11）**：修复辅助存储阻塞终态、旧回执/快照倒退、挂起旧流锁住下一问、失败原话及 retryOf 错配；补齐图片/多卡恢复、准备未准入与准入早期失败区分、完整长文存档、握手代次和 SSE 坏帧处理。API **214 套 / 4815 项**、Web **323 项**及生产构建通过，723 份相关源码与 fixture 指纹稳定；无新增付费调用或正式业务/记忆写入。当前进入实体手机弱网与连续对话终验。见 [修复与最终验证](logs/CHANGELOG_2026-11-11.md)。

> **手机 AI 传输与重试审计（2026-11-11，修复前基线）**：复现结果已落回执但 SSE 终态受同步写入阻塞、旧回执擦除完成正文、权威读取失败推断假失败及恢复原话错配；另有失败重试身份、长文历史截短和握手竞态。指定编号实际为文章概述而非 Hello，不能把离线反例当本次网络/触摸根因。此条记录修复前的只读审计，后续修复与最终验收见上方索引；原红证据保留。见 [审计报告](../temp/api-logs-archive/REVIEW_2026-11-11_AI_MOBILE_TRANSPORT.md) 与 [审计日记](logs/CHANGELOG_2026-11-11.md)。

> **授权续跑误失败修复（2026-11-11）**：修复旧授权消息编号覆盖新请求、旧活动重复气泡及活动死线误判运行状态；授权等待与真实失败分开显示。新增 `retryOf` / `continuedBy` 持久化关联和同步 `retryLinks`，刷新、跨设备继续及重复提交保持同一回复身份，父失败请求在模型调用前事务认领。Web **230/230**、API **212 套 / 4770 项**及构建通过，无需数据库结构迁移。见 [变更与验证记录](logs/CHANGELOG_2026-11-11.md)。

> **AI 对话按实际工具与成果校验（2026-11-11）**：场景与原话同包交给模型选工具，不新增分类调用；无查询写作保留 Markdown 源文，显式业务/记忆效果仍核对真实回执。补齐思考按最终范围净化、中间模型文本重传净化、私有文本切限前凭据净化和代码块误折叠；纯文章超 12000 字符明确报错。模型 token、授权、工具及额度预算保留。当前 API 212 套 / 4770 项、Web 280 项和构建通过，695 份源码指纹在验证期间稳定；本轮无新增付费模型调用。当前版本的验证与阶段见 [变更日记](logs/CHANGELOG_2026-11-11.md)。

> **聊天页逻辑模块化执行（2026-11-11）**：Assistant.vue 1112→118 行，保留三个展示组件，新增十个功能 composables、共享状态、controller 和服务适配层。messages、conversationId 与全局准入闸门保持单一状态图，跨模块回调显式接线，effectScope 统一释放；test:ai **217/217**、SFC 编译与浏览器检查通过。补齐晚到回执、业务产物及设置重载的旧请求隔离。本轮未测性能、不运行 build；NVDA/物理手机与 C4 后端依赖继续单列。见 [执行计划](../temp/api-logs-archive/PLAN_AI_CHAT_LOGIC_MODULARIZATION.md)、[执行日记](logs/CHANGELOG_2026-11-11.md) 和 [模块边界](../web/src/views/AI/assistant/README.md)。

> **聊天页剩余逻辑结构评估（2026-11-11）**：1112 行父页中约 1029 行为脚本，建议继续按模型设置、图片/活动/视口、会话、授权/同步和请求流程分阶段提取 composables；保持会话与请求状态单一所有者，先适配当前脚本抽取式测试。父页 150–300 行仅为参考目标。本轮仅评估与文档，未重构源码。见 [模块化建议](../temp/api-logs-archive/PLAN_AI_CHAT_LOGIC_MODULARIZATION.md) 与 [评估日记](logs/CHANGELOG_2026-11-11.md)。

> **聊天界面 A/B/C 落地与组件拆分（2026-11-11）**：图片保留至会话边界、流式输入解锁、中段独立重问、移动 Enter 换行、读屏静音/完成公告、手动活动偏好与常驻回底已实现。消息/输入/历史拆到 `web/src/views/AI/assistant/components/`，父页 1516→1112 行；状态机仍统一协调。`test:ai` 192/192、SFC 编译与浏览器交互检查通过；NVDA/物理手机留人工终验，C4 历史摘要独立后端任务。见 [执行日记](logs/CHANGELOG_2026-11-11.md) 与 [计划状态](../temp/api-logs-archive/PLAN_AI_CHAT_UX_POLISH.md)。

> **AI 核心收口与 qwen 对话中断修复（2026-11-11）**：修复 SSE 信封误占正文大小预算、损坏流误报成功、未核验思考上屏和审计 JSON 裸截；增加服务器产物驱动的操作状态与混合卡恢复身份，补齐 Web 设置事务 fixture。当前 API 冻结清单 209 套 / 4521 项全过，Web 242 项与构建通过，独立真库 7 项及 4 组 SSE/恢复验证通过并完成清理；真实 qwen 同会话两轮完成，回执/历史回读零新增模型调用，共 2 次实际调用，正式业务和记忆未写。原请求仅保留 ERR_BAD_RESPONSE，历史超限归因保持证据限制；核心架构进入发布候选验收，未宣称任意自然语言真实性或全业务最终验收。最终证据与版本清单见 [收口日记](logs/CHANGELOG_2026-11-11.md)。

> **聊天界面体验打磨执行前核实（2026-11-11）**：已定位 A/B/C 原计划并核对当前实现，`test:ai` 基线更新为 161/161、0 失败。建议先批 A、再批 B+C1-C3；补齐设置重载/当前会话删除的图片释放、成功历史原话配对、独立重问保留草稿与附件、业务产物/OCR 保护及读屏/回底验收。C4 历史摘要另立后端任务。本轮仅文档核实，未实施前端功能。见 [执行前核实](logs/CHANGELOG_2026-11-11.md) 与 [原计划](../temp/api-logs-archive/PLAN_AI_CHAT_UX_POLISH.md)。

> **聊天界面体验打磨计划（2026-11-11，追加171）**：Assistant.vue 全量通读评审后归纳 8 项体验优化为 A/B/C 三批——批A P1（图片预览保留到会话边界、流式期间输入框解锁）、批B P2（中段回答「以此重问」追加式重试、移动端 Enter=换行）、批C P3（读屏流式静音 / 活动流不覆盖手动展开 / 常驻回底）；历史列表「最后一句摘要」依赖后端列表接口扩展字段，单列另立，本轮零后端改动。仅编制计划未动源码。见 [计划](../temp/api-logs-archive/PLAN_AI_CHAT_UX_POLISH.md) 与 [编制记录](logs/CHANGELOG_2026-11-11.md)。

> **v3Service 瘦身子步3：claims 规则表化（2026-11-11，追加170）**：v3Claims.js 161→223 行改写——词素 LEXICON 归组 + 五张声明式规则表（CLAIM_RULES 12 / AFFIRMATIVE_RULES 5 / CONTINUATION_GUARDS 三阶段 / EFFECT_RULES 3+payment 兜底内联 / RECEIPT_RULES 4 两谓词形态并存）+ 双层 fail-closed 守卫（加载期结构断言 + 运行时分类白名单）+ 主循环接线；正则 source+flags 集合 diff 35→35 为空、导出契约冻结、四段顺序不变（v3ResultAssembly 调用行 diff 为空）；顺带修剪 v3Service.js:31 空置 import（1127→1126）。定向 20 套/696 项（-7.6% 耗时）、全量离线 205 套/4474 项 0 失败 ×2。卫星 query*Claims 家族表化留待后续子步。见 [日记](logs/CHANGELOG_2026-11-11.md) 与 [计划](../temp/api-logs-archive/PLAN_AI_V3SERVICE_STEP3_CLAIMS.md)。

> **v3Service 瘦身子步2：答复组装阶段出闭包（2026-11-11，追加169）**：v3ResultAssembly.js 新建（assembleTurnResult，buildResult 逐字搬移 + facts 46 键显式枚举，查询后处理/终稿声明校验/恢复载荷组装三合一阶段），v3Service 1186→1127 行；函数体逐字节一致，四段顺序不变；离线 205 套/4474 项 0 失败 ×2。真库 S3/S5 红=并行会话 v3 流式切换在途（传输层，mock harness 无 v3 SSE 脚本），与本轮无关，归其收口。子步3（claims 规则表化）前置已满足。见 [日记](logs/CHANGELOG_2026-11-11.md) 与 [计划](../temp/api-logs-archive/PLAN_AI_V3SERVICE_STEP2.md)。

> **v3Service 瘦身子步1：呈现函数群纯移动（2026-11-11，追加168）**：v3AnswerPresentation.js 新建（393 行，validateChart/buildQueryAnswer/scrubModelProse/rowsTable 等 12 个模块级纯函数 + 3 局部常量），v3Service 1557→1186 行，公开导出契约不变；逐字节比对零逻辑变化（唯一差异一个空行），空置 require 修剪 10 行。全量离线 205 套/4473 项 0 失败。闭包编排与四段顺序未动；子步2 需先盘点闭包 claims 管线的可变状态所有权。见 [日记](logs/CHANGELOG_2026-11-11.md)。

> **AI 进程级验收 + 真实供应商 + 浏览器实测（2026-11-10，追加167）**：S3 多进程日额度与 S1 真实进程重启真库验收通过（fork 子进程共享隔离库，脚注关闭）；真实 qwen（密文只读复制，门控套件）非流式/SSE/思考开关 4/4，顺带修复 v3 链 provider 审计不记 thinking_enabled 的缺口；浏览器全链路实测通过（SSE 状态条 → 授权门控弹窗 → 24h 会话授权续流 → 真实回答 + 数据卡），SSE/浏览器验收缺口关闭。离线全量 205 套中 3 项失败均属并行会话在途文件（requestGuard/conversationSync），本轮范围全绿。见 [日记](logs/CHANGELOG_2026-11-10.md)。

> **AI Agent 基本能力补全计划（2026-11-10）**：agent 缺口盘点后立项 A calc 确定性计算工具 / B 供应商故障切换 / C 黄金评测集 / D 主动智能（立项级），暂缓池 E 图片理解 / F 语音输入；web_search 自建路线单列 §7。2026-11-11/12 状态：B failover 已否决（计费模式禁止动态切换）；A calc / §9 预算配置进库（ai_config 单行表，live_dev 已建表）/ §10 历史上下文 token 化预算已实施；**C 黄金评测集已实施**（31 条 JSONL 用例：offline 档并入默认回归、live 档 `AI_EVAL_LIVE=1 npm run test:ai:eval:live` 报告分版本落档，见 tests/eval/README.md）；副产物修复 v3Tools queryMeta 丢失 cardTypes。剩余项已全部立 PLAN 交接（2026-11-12）：web_search（PLAN_AI_WEB_SEARCH.md）/ D 主动智能（PLAN_AI_PROACTIVE.md，形态确认单待勾选）/ 生产暗发布（PLAN_AI_PROD_ROLLOUT.md，建号=唯一人工步骤）/ live 评测种子补齐（总计划 §11）；建议顺序见总计划顶部索引。见 [计划](../temp/ALL_PLAN_md/PLAN_AI_AGENT_CAPABILITIES.md) 与 [编制记录](logs/CHANGELOG_2026-11-10.md)。

> **AI 候选契约单源化与真库 harness 加固（2026-11-10，追加166）**：候选映射 7 处副本收敛到 datasetCapabilities 单源（深冻结 + 派生枚举 + 单属组/源域/源数据集契约断言）；测试侧新增 tablesRead 表引用白名单断言（候选 SQL 逐条按允许表集合比对）；真库 harness 建表改按 41 表名集合硬断言并核对关键列/索引，DDL 解析器引号/注释分号回归进默认套件。独立复跑离线 204 套/4462 项、隔离 MySQL 5 项全过；未调付费模型、真库仅隔离 live_ai_test。见 [日记](logs/CHANGELOG_2026-11-10.md)。

> **A1 修复关闭（2026-11-10）**：基金候选分支 candidateOnly 直查 fund 的 id/name，不再 JOIN 收益历史；单测断言改为表名任意出现并补 datasets 空断言，反证确认旧缺陷路径必被咬住。定向 35/35、全量离线 202 套/4452 项、隔离真库 5/5、独立复核脚本 6/6 翻转全过。见 [日记](logs/CHANGELOG_2026-11-10.md)。

> **AI 一阶段五项修复验收（2026-11-10）**：原 S1–S5 在列明范围内通过；独立复跑离线 202 套/4452 项、隔离 MySQL 1 套/5 项全过，finance 候选不再读取流水。另新增 A1/P2：基金候选仍 JOIN 收益历史，历史表故障会阻断候选（已修复关闭，见上）。旧 v2 真库 9 场景停用保留，尚需迁移 V3；Store 重建、单进程并发和本地脚本供应商的范围单列。见 [验收报告](../temp/api-logs-archive/REVIEW_2026-11-10_AI_STAGE1_FIX_ACCEPTANCE.md) 和 [日记](logs/CHANGELOG_2026-11-10.md)。

> **AI 一阶段修复复审（2026-11-10）**：S1、S2、S3、S5 在源码核对与离线回归范围内可关闭；S4 部分修复，候选读取仍执行无关流水 SQL，表权限或脏金额会阻断候选，保留 1 项 P2。独立回归 10 套/336 项通过，4 个隔离回放确认剩余缺口；未调付费模型、未访问真实库，Web 未测试。原审计报告与证据保留。见 [复审报告](../temp/api-logs-archive/REVIEW_2026-11-10_AI_STAGE1_FIX_REVIEW.md) 和 [变更日记](logs/CHANGELOG_2026-11-10.md)。

> **AI 接入一阶段审计（2026-11-10）**：重新核对流程、执行、逻辑、错误处理和响应，确认 5 项需整改问题（1 P1 / 4 P2）：接入商更新未持久化、临时拒绝后同请求号同步状态失真、并发日额度竞争、候选组读取未隔离，以及默认分析/闲聊可显示虚假执行完成声明。API 179 套/4078 项、Web 210 项及构建通过；8 个新离线复现场景保留，未修改生产实现，未新增付费模型或真实数据库测试。见 [审计报告](../temp/api-logs-archive/REVIEW_2026-11-10_AI_STAGE1.md) 和 [变更日记](logs/CHANGELOG_2026-11-10.md)。

> **图表异常与重复恢复修复（2026-11-10）**：后端曾保存双指标饼图，前端严格拒绝后导致回执/历史/SSE 重复失败。已统一饼图规则，展示端保留正文和数据、单独提示不可用图表，永久协议异常停止自动重连/轮询。实际坏消息只读恢复验证通过，5173 已提供更新代码。见 [修复记录](logs/CHANGELOG_2026-11-10.md)。

> **聊天列表 500 修复（2026-11-10）**：孤立活动清理关联了 `general_ci` 会话表与 `unicode_ci` 活动表，触发排序规则冲突。已显式统一关联比较，并隔离辅助清理异常。真实 MySQL 临时表 HTTP 验证返回 200、归属/清理正确，相关 38 项回归通过。见 [修复记录](logs/CHANGELOG_2026-11-10.md)。

> **A/B 设备聊天同步修复（2026-11-10）**：增加鉴权 GET SSE（后端每 2 秒状态读取）与 15 秒快照兜底，同步远端排队/处理、最终消息和当前卡片版本。修复同原文误去重、多卡等待气泡残留、候选转草稿重复、旧会话异步回填和游标漏取，远端删除可即时清理。024 活动表已专项幂等升级并登记；同步不重新调用模型。见 [变更日志](logs/CHANGELOG_2026-11-10.md) 和 [原审查](../temp/api-logs-archive/REVIEW_2026-11-10_AI_CHAT_DEVICE_SYNC.md)。

> **AI 请求接纳策略（2026-11-10）**：保留去重与调用预算；默认 30 次/分钟、同用户串行，短时并发先等待空位（最多 30 秒、每进程/用户 8 个等待者）。等待耗尽为 `503 AI_REQUEST_BUSY`，真实频率超限为 `429 AI_RATE_LIMIT`；临时拒绝不占请求编号，取消保留零调用回执。前端展示等待并合并处理/等待时限。关联回归 125 项、前端 AI 132 项及构建通过。见 [变更日志](logs/CHANGELOG_2026-11-10.md)。

> **AI 验收复审收尾（2026-11-10）**：ME03 行长证据与 MC03 默认并发已修复，真实商汤准确回答 307 字符/搜索第 1–240 字符，现有 7788 在途第二请求 429 且零模型调用；补齐 H23 独立历史投影、真实备份异步失败和中文 regex 成功。193 套/4325 项回归通过，本轮 8 次商汤调用，正式 21 表及 memory 无变化。当前源码 `f4dc7700…`，旧 Q123 与新定向结果分版本记录。见 [复审报告](../temp/ai-review-closeout-20261110/REVIEW_CLOSEOUT.md) 和 [变更日志](logs/CHANGELOG_2026-11-10.md)。

> **AI 剩余验收交接计划（2026-11-10）**：15类隔离业务执行、12组记忆并发/异常、最终冻结123场，含执行顺序、证据和复审标准。见 [执行计划](../temp/ALL_PLAN_md/PLAN_AI_REMAINING_ACCEPTANCE.md)（已终态归档）与 [编制记录](logs/CHANGELOG_2026-11-10.md)。本轮只写计划，待另一位AI执行。

> **AI 剩余验收执行（2026-11-10）**：P01–P15 正向/边界、BG01–BG08、记忆 12 组与最终冻结 123 场已执行。修复记忆跨进程丢写、取消晚写与断连回执停留 running；最终 sourceDigest `fe071a65…`。Q123 122/123 通过（H23 合法否定保留 failed），全回归 192 套/4315 项通过，正式业务 21 表无变化。遗留 ME03 正文行长度误报、7788 开发配置并发未拒绝。见 [执行证据](../temp/ai-remaining-acceptance-20261110-125717/REVIEW_REQUEST.md)、[复审包](../temp/ai-remaining-acceptance-20261110-125717/review_bundle.json) 与 [变更日志](logs/CHANGELOG_2026-11-10.md)。

> **AI API 实效收尾（2026-11-10）**：语言、图表范围、记忆 literal/regex 和高级修改已实测通过；8 查询、预算提案 15 检查、9 记忆场景最新通过。全回归 169 套/3947 项、最终影响链 6 套/307 项分版本记录；本轮正式业务 23 表快照一致。原失败保留，未正式入库。详见 [最新验收](../AI_ALL23_ACCEPTANCE.md)、[API 实效报告](../temp/ai-api-closeout-20261110/API_CLOSEOUT_REPORT.md) 和 [变更日志](logs/CHANGELOG_2026-11-10.md)。

> **先前 AI 23 数据集有界验收（v4.20）**：历史 123 场真实覆盖、API 163 套/3860 项及 Web 180 项通过记录保留。该轮语言、图表文字关注项已在上述新一轮处理；旧业务快照差异未改写。见 [历史变更记录](logs/CHANGELOG_2026-11-10.md)。

> **AI 工具集测试交接（2026-11-09）**：根目录新增 [工具现状与全场景测试交接](../AI_TOOLSET_TEST_HANDOFF.md)，列出8个原生工具、23个查询数据集、15种提案及参数/范围/权限/上下文矩阵，区分已有回归与待核实缝隙。本轮仅文档与静态核对。详见 [变更记录](logs/CHANGELOG_2026-11-09.md)。

> **AI 卡消费跨月排名（2026-11-08）**：修复消费数据集拒绝支出方向参数的问题，新增完整日期范围按卡累计后排序，统一最近 N 个月与跨轮统计粒度；工具错误在原控制台打印具体参数。AI 回归 79 套 / 1787 项通过，真实账本只读核对通过。详见 [变更与验证记录](logs/CHANGELOG_2026-11-08.md)。

> **AI 格式校验控制台诊断（2026-11-08）**：失败时打印 `[AI Check]` 具体字段/规则与 `[AI Result]` 脱敏最终正文；补齐澄清输出协议，保留原校验和不重试行为。AI 相关离线回归 76 套 / 1723 项通过。详见 [变更与验证记录](logs/CHANGELOG_2026-11-08.md)。

> **AI 控制台文字颜色（2026-11-08）**：`[AI Say]` 及供应商思考正文使用黄色，打印后恢复默认色；保留脱敏和请求关联信息。详见 [变更记录](logs/CHANGELOG_2026-11-08.md)。

> **AI 长期记忆与历史承接（2026-11-08）**：新增按用户隔离的 Markdown 自主记忆、历史原话回查和预算内近期上下文；记忆保存以真实工具回执为准，编码或文件异常逐份隔离。用户记忆不纳入 Git。详见 [本轮变更与验证记录](logs/CHANGELOG_2026-11-08.md) 和 [记忆文件说明](data/memory/README.md)。

> **AI 提案卡陈列室（2026-11-07）**：补齐 14 类、34 个本地示例，支持筛选、重置与离线操作演示；优化手机输入及触控区域、收益编辑、失败终态和备份回执。构建与 87 项 AI 测试通过，另有既有登录页默认值校验失败。详见 [陈列室与移动端调整记录](logs/CHANGELOG_2026-11-07.md)。

> **AI真实联调（2026-11-06）**：`feat/ai-assistant`，与Web同名分支对齐。运行服务接真实只读账本和DeepSeek；聊天内草稿可编辑/核对/取消，人工确认入账经版本校验及统一事务。已移除运行沙盒，mock仅限自动测试。详见 [AI模块与联调说明](src/modules/ai/README.md) 和 [真实联调日志](logs/CHANGELOG_2026-11-06.md)。

> **业务开放与 OCR（2026-11-06）**：已统计 20 模块、23 路由组、183 HTTP 接口，给出 AI 开放矩阵及 GET 写副作用清单。聊天可上传支付截图/账单，由真实 DeepSeek 识别为待核对草稿或多笔核对表。详见 [业务开放评估报表](../temp/api-logs-archive/AI_BUSINESS_OPENING_ASSESSMENT_2026-11-06.md) 和 [OCR 联调日志](logs/CHANGELOG_2026-11-06.md)。

> **金额精度修复（2026-11-06）**：修正四位截断时的浮点倍率误差，避免39.91显示/折算成39.9099；真实四位小数仍保留。修复全额还款填值与信用金额输出边界。详见 [金额精度修复与真库核查](logs/CHANGELOG_2026-11-06.md)。

> **AI 表增量迁移（2026-11-06）**：补齐 [018_ai_persistence.sql](mysql/migrations/018_ai_persistence.sql)，创建草稿、会话与消息三表，支持已有环境幂等升级。详见 [MySQL 升级说明](mysql/README.md) 和 [迁移补齐日志](logs/CHANGELOG_2026-11-06.md)。

> **AI 业务开放规划（2026-11-06）**：已按负责人新意见及实际还款/精密执行排除、OCR不落盘决定，完成三子代理分析和[最终PLAN与跟踪溯源](../Docs/docs/ai/PLAN/README.md)。新增业务尚未实施；详见 [规划日志](logs/CHANGELOG_2026-11-06.md)。

为 Golden Finance 移动端 PWA / APP / Web 应用提供 RESTful API 与 AI SSE 支持，涵盖用户认证、财务管理、银行卡、工资核算、理财投资、数据备份及受控 AI 助手。

## 功能特性

| 模块 | 功能 |
|------|------|
| 🔐 认证 | 管理员首次注册、登录、JWT 认证、Token 刷新、登出、系统锁定 |
| 🔑 安全 | PIN 码安全验证（423 锁定 + 8303 风险路由挑战）、预握手 AES 密钥交换、httpOnly Cookie 认证、APP 签名自检、多层请求校验（防重放/IP/指纹） |
| 💰 账务 | 收支流水管理（收入/支出/转账/信用卡消费/还款）、流水冲正、账户余额 |
| 💳 银行卡 | 借记卡/信用卡管理、账单周期计算、还款管理、分期管理 |
| 📊 报表 | 流水筛选、收支统计、类目占比、月度趋势、负债统计 |
| 📈 理财 | 理财产品登记、净值追踪、收益明细、变动走势 |
| 🏷️ 分类 | 收支分类管理（银行分类走 `/category?type=bank`） |
| ✅ 待办 | 日历日程、提醒管理 |
| 💼 工资 | 工作信息、工资日历、薪资统计、日薪计算 |
| 👤 用户 | 资料更新、邮箱变更、密码修改（均需邮箱验证码） |
| 🏠 资产 | 资产快照登记、固定资产管理 |
| 📉 预算 | 购物/出行/餐饮预算管理 |
| 📁 上传 | 文件/图片上传（Sharp 处理，WebP + PNG 双格式） |
| 📓 日记 | 动态发布/编辑/分享（支持公开链接访问） |
| 📦 数据管理 | 系统检查、备份、导出、导入（登录日志见 `/auth/login-logs`） |
| 🔁 周期支出 | 固定周期支出提醒 |
| 🌍 地理位置 | IP 定位、逆地理编码代理 |
| 🔗 分享 | 动态公开分享（免登录访问） |
| 🤖 AI 助手 | V3 聊天/SSE、受控账本查询、计算、OCR、待人工核对的草稿与提案、回执恢复和跨设备同步 |
| 🧠 AI 个性化 | 长期记忆维护及历史恢复、带原话证据的用户画像、自定义规则、本人额度与超时设置 |
| 🔎 联网搜索 | 自建执行器、来源引用、日额度与会话级子授权；需用户明确开启，不替代账本证据 |

## 项目结构

以下按 **2026-11-13 的实际目录**整理；运行数据目录会随使用增加，`node_modules/`、真实 `.env` 和用户私有数据不作为可提交源码。

```text
api/
├── app.js                       # Express 应用、路由挂载与直接启动入口
├── package.json                 # 依赖与 npm 命令（没有 build 命令）
├── package-lock.json            # 依赖锁文件
├── .env.example                 # 可提交的配置模板；真实 .env 不入库
├── ENV_SETUP.md                 # 首次启动、环境检查与 Web/反代对齐
├── README.md                    # 项目入口说明（本文）
├── jest.config.js               # 默认离线单元/集成测试
├── jest.real.config.js          # 独立真实 MySQL/供应商测试
├── jest.eval.config.js          # 真实供应商黄金评测
│
├── src/
│   ├── api/
│   │   └── index.js             # /api/v1 下集中注册 23 个路由组
│   ├── modules/                 # 20 个业务模块，按需设置 api/controller/model/rules/service
│   │   ├── auth/                # 首次注册、登录、Token、用户信息与登录日志
│   │   ├── security/            # PIN、锁定与风险路由验证
│   │   ├── account/             # 流水、余额与结算（api/controller/model/rules/service）
│   │   ├── category/            # 收支分类；银行分类同路由 type=bank
│   │   ├── card/                # 银行卡、账单、还款、信用额度（含 core/）
│   │   ├── user/                # 资料、邮箱与密码
│   │   ├── upload/              # Multer + Sharp 文件/图片处理
│   │   ├── moment/              # 动态与日记
│   │   ├── asset/               # 资产快照与登记
│   │   ├── todo/                # 待办日程与提醒
│   │   ├── work/                # 工作信息、工资日历与薪资统计
│   │   ├── fixed_asset/         # 固定资产与回收站
│   │   ├── budget/              # 购物/出行/餐饮预算
│   │   ├── fund/                # 理财持仓、收益历史与走势
│   │   ├── recurring/           # 周期支出、分期计划及 cron.js 定时扫描
│   │   ├── dataManager/         # 系统检查、备份、导出与导入（含 service/）
│   │   ├── flow/                # 流水详情与日历（当前仅 api/）
│   │   ├── geo/                 # IP 定位与逆地理编码代理
│   │   ├── share/               # 公开分享与 SSR 页面
│   │   └── ai/                  # V3 聊天、受控工具、OCR、草稿/提案与个性化
│   │       ├── api/index.js     # AI HTTP/SSE 路由与服务接线
│   │       ├── service/         # 编排、工具、读层、存储、授权与执行边界
│   │       └── README.md        # AI 当前能力、接口及使用说明
│   ├── common/
│   │   ├── config/             # db.js 业务 MySQL 池（10 连接）、jwt.js
│   │   ├── middleware/         # 11 个公共中间件
│   │   │   ├── securityCheck.js # 唯一生效的安全请求校验实现
│   │   │   ├── authGuard.js     # JWT / httpOnly Cookie 认证
│   │   │   ├── cookieParser.js  # Cookie 解析
│   │   │   ├── pinSecurityGuard.js # PIN 会话锁定守卫
│   │   │   ├── pinLockGuard.js  # PIN 失败锁定与风险挑战
│   │   │   ├── authSecurityData.js # 前端加密数据解密
│   │   │   ├── accountLockCheck.js # 账户锁定检查
│   │   │   ├── emailCodeRateLimit.js # 邮箱验证码频率限制
│   │   │   ├── appSignatureGuard.js # APP 签名自检
│   │   │   ├── errorMiddleware.js # 404 与统一错误处理
│   │   │   └── validate.js      # Joi 参数校验
│   │   ├── services/           # 财务预检、支付冲突检查与 AI 业务动作执行
│   │   ├── utils/              # 金额精度、加密、RSA、Cookie、邮件、ID 与日志工具
│   │   ├── controller/         # README 占位，当前没有公共控制器实现
│   │   └── model/              # README 占位，当前没有公共模型实现
│   └── init/
│       ├── index.js            # 增量/深度初始化入口
│       ├── autoDatabase.js     # 数据库自动创建
│       ├── schemaSync.js       # 表结构同步
│       └── migrationRunner.js  # 增量迁移执行器
│
├── mysql/
│   ├── README.md               # 建库、增量升级与 AI 只读授权说明
│   ├── live.sql                # 当前完整数据库结构（42 张表）
│   ├── live_V1.0.0.sql         # V1.0.0 历史基线
│   ├── live_old_version.sql    # 历史结构备份
│   ├── migrations/             # 当前 001—020；019 合并旧增量，020 为本人 AI 预算
│   └── backups/                # 初始化/结构同步的 SQL 备份
│
├── data/                       # 本地持久化与业务备份，不应提交私有内容
│   ├── memory/                 # <SHA256(userId)>/ 下的 Markdown 长期记忆
│   ├── personalization/        # <SHA256(userId)>/state.json：规则、画像、开关及版本记录
│   ├── rsa-keys.json           # RSA 持久化密钥（保留原文件，不公开）
│   ├── sql/
│   │   ├── table/              # 表导出、SQL/ZIP 文件
│   │   └── backup/             # 系统备份
│   └── uploads/                # 本地上传暂存；公开资源见 public/uploads/
│
├── public/                     # /api/public 静态资源根目录
│   ├── admin-register.html     # 首次管理员注册页面
│   ├── admin-register.js       # 注册页面脚本
│   ├── database-init.js        # 数据库初始化页面脚本
│   ├── share/diary/            # 分享页静态资源
│   └── uploads/                # 公开上传资源（银行、动态、产品等分目录）
│
├── tests/
│   ├── README.md               # 测试说明
│   ├── setup.js                # 默认 Jest 环境与全局夹具
│   ├── unit/                   # 单元测试（含本目录的 fixtures/helpers）
│   ├── integration/            # HTTP 契约、AI 预算、同步与个性化集成测试
│   ├── eval/                   # 离线/真实供应商黄金评测，cases/ 存放 JSONL
│   ├── real/                   # 隔离 MySQL/供应商测试与 harness
│   ├── fixtures/               # 捕获响应、回放及场景资料
│   └── helpers/                # 共用夹具与明确隔离的 legacy 夹具
│
├── tools/                      # npm 引用脚本与长期运维工具（不是 scripts/）
│   ├── env-check.js            # 环境变量与数据库连接检查
│   ├── ai-capability-check.js  # AI 工具定义/校验/分发接线检查
│   ├── ai-memory-backup.js     # 记忆/个性化加密备份与新目录恢复
│   ├── mock-database.js        # 独立 Mock 数据库生成/校验入口
│   └── mock/                   # Mock 分域生成器、校验与 README
└── logs/                       # 按日期合并的变更日志；本地仍有历史材料目录
    └── CHANGELOG_YYYY-MM-DD.md
```

### 目录与文档入口约定

- **源码入口**是根目录 `app.js`，不是 `src/app.js`；当前没有 `scripts/` 目录，运维入口以 `package.json` 和 `tools/` 为准。
- **AI 并非传统 MVC 模块**：`api/index.js` 接线服务，`service/v3Service.js` 编排轮次，呈现和结果组装分别由 `v3AnswerPresentation.js`、`v3ResultAssembly.js` 承担；工具定义与分发由 `toolRegistry.js` 统一管理。细节见 [AI 模块说明](src/modules/ai/README.md)。
- **新增变更日志**只写 `logs/CHANGELOG_YYYY-MM-DD.md`，同一天合并；评审、证据、诊断和非变更日志计划放在工作区 `../temp/api-logs-archive/`。现有历史子目录不代表新的写入位置。
- **一次性验收/诊断脚本**放在工作区 `../temp/api-tools-oneoff/`，不要重新塞回 `tools/`；已完成的根目录 PLAN 归档到 `../temp/ALL_PLAN_md/`。这些工作区归档不是 API 仓库发布内容。
- **私有存储**通过接口和运维工具管理，不直接手改 `state.json`；备份时记忆与个性化状态需配套保存。详见 [记忆说明](data/memory/README.md)、[数据库说明](mysql/README.md) 与 [试行运行手册](../Docs/docs/ai/trial-runbook.md)。


## API 路由总览

所有 API 挂载在 `/api/v1` 下，需经过 `securityCheck` 中间件校验（公开分享和静态资源除外）。

> 🔒 2026-10-13 冗余接口清理已删除 `/bank`、`/bank-category`、`/resource`、`/database`；`/dashboard` 从未挂载。银行分类走 `/category?type=bank`，文件资源走 `/upload`。
> 当前 Node 在 `/api/v1` 下挂载 **23 个路由组**（包含后续新增的 `/ai`）；Go 的业务路由需按独立实现核对，**不提供当前 Node AI 功能**。静态资源、探活及根路径分享页另列。

| 前缀 | 模块 | 主要功能 |
|------|------|---------|
| `/api/v1/auth` | auth | 首次管理员注册、登录、用户信息、Token 刷新、登出、系统锁定、登录日志 |
| `/api/v1/security` | security | PIN 码状态/设置/验证/修改、风险路由验证 |
| `/api/v1/account` | account | 收支流水 CRUD、冲正、转账 |
| `/api/v1/accountBalance` | account | 账户余额管理（虚拟账户同步） |
| `/api/v1/category` | category | 收支分类 CRUD（含银行分类 `?type=bank`） |
| `/api/v1/card` | card | 银行卡 CRUD、卡片流水查询 |
| `/api/v1/card/bill` | card | 信用卡账单 CRUD、账单流水明细 |
| `/api/v1/card/repay` | card | 信用卡还款 CRUD |
| `/api/v1/user` | user | 资料更新、邮箱变更、密码修改（均需邮箱验证码） |
| `/api/v1/upload` | upload | 文件/图片上传（支持多文件） |
| `/api/v1/moment` | moment | 动态/日记 CRUD |
| `/api/v1/asset` | asset | 资产快照与登记 |
| `/api/v1/todo` | todo | 待办日程 CRUD |
| `/api/v1/work` | work | 工作信息、工资日历、薪资统计、日薪 |
| `/api/v1/fixedAsset` | fixed_asset | 固定资产 CRUD、回收站 |
| `/api/v1/budget` | budget | 购物/出行/餐饮预算管理 |
| `/api/v1/fund` | fund | 理财产品登记、净值追踪、收益明细 |
| `/api/v1/recurring` | recurring | 周期固定支出提醒 |
| `/api/v1/flow` | flow | 流水详情查询、日历聚合 |
| `/api/v1/data-manager` | dataManager | 系统检查/备份/导出/导入 |
| `/api/v1/geo` | geo | IP 定位、逆地理编码代理 |
| `/api/v1/share` | share | 公开分享查看（免登录，白名单放行） |
| `/api/v1/ai` | ai | V3 聊天/SSE、受控查询、OCR、人工确认草稿/提案、授权、设置、个性化与回执同步 |
| `/api/public` | 静态资源 | `public/` 目录中的页面与上传资源 |
| `/api/health` | 探活 | GET，返回服务标识、版本和时间，不鉴权、不查询数据库 |
| `/share/diary/detail` | 分享 SSR | GET/POST 公开分享页，不走业务安全头校验 |

AI 路由的 `/v3` 表示聊天协议版本，项目公共前缀仍是 `/api/v1`；详见 [AI 接口说明](src/modules/ai/README.md#v3-接口)。

## 认证与安全体系

### 认证流程

```
客户端                          服务端
  │                               │
  ├── GET /auth/handshake ───────►│ 交换 AES 密钥（预握手）
  │◄─────── { aesKey, iv } ──────┤
  │                               │
  ├── POST /auth/login (AES加密)─►│ 安全头校验 → JWT 签发
  │◄─────── { token } ────────────┤
  │                               │
  ├── 业务请求 (JWT + 安全头) ────►│ authGuard → pinSecurityGuard
  │◄─────── 数据 ──────────────────┤
  │                               │
  │  (若返回 423)                 │
  ├── POST /security/pin/verify ─►│ PIN 验证解锁
  │◄─────── 200 OK ───────────────┤
```

### 安全特性

| 层级 | 机制 | 说明 |
|------|------|------|
| 传输加密 | AES 预握手 | 首次请求交换 AES 密钥，后续 POST/PUT/DELETE 自动加解密。**仅通道混淆，无认证性**（任意 `fp` 均可换取密钥） |
| 请求校验 | securityCheck | 校验 X-Requested-With、时间戳（±2min）、一次性 nonce（防重放）、IP 合法性、指纹一致性。**不含请求签名**（历史文档所称"MD5 签名"从未生效，详见 `logs/CHANGELOG_2026-09-21.md`） |
| 身份认证 | JWT Token / httpOnly Cookie | Bearer 头优先，缺失时回落 httpOnly Cookie（P0-5，2026-10-08）；authGuard 自动验证 |
| APP 完整性 | 签名自检 | `APP_SIGN_SHA256` 白名单校验 `x-app-sign-sha256`（P1-28）；未配置=守卫不启用，`strict` 模式连浏览器也要求带头 |
| 反代信任 | TRUST_PROXY_HOPS | 只按声明的层数取 `X-Forwarded-For`，避免伪造 `req.ip` 绕过按 IP 的风控与限流（P1-18，2026-10-08） |
| 令牌吊销 | `password_changed_at` + `TOKEN_MAX_SESSION_DAYS` | 改密后旧令牌刷新被拒；会话超过 N 天（默认 90）强制重登 |
| 敏感操作 | PIN 码 | 6 位数字 PIN 码二次验证，失败锁定；风险路由返回 8303 挑战 → `/security/pin/route-verify` 换一次性 token 后原请求重发 |
| PIN 守卫容错 | fail-closed | 守卫内部异常且用户已设置 PIN 时拒绝请求（503），不再静默放行 |
| 重放自愈 | 业务码 `8401` | nonce 复用返回 `400 + {code:8401, retryable:true}`（独立码，不与其它 400 混用），前端识别后**自动重发一次**，用户无感；重发仍失败才提示 |
| 风控可灰度 | `PIN_RISK_MODE` | 严格 / 观测 / 关闭 三档，`.env` 可切、无需回滚代码；非严格模式启动打印告警 |
| 会话锁定 | 423 状态码 | 手动锁定/自动锁定后返回 423，前端引导 PIN 验证 |
| 密钥强度 | secretGuard | 生产环境密钥缺失/过短/占位值 → 拒绝启动（fail-fast），杜绝静默回退到硬编码常量 |
| 密码存储 | bcryptjs | 单向哈希加密存储 |
| 安全头 | Helmet | 自动添加安全相关 HTTP 头 |
| CORS | 白名单 | 生产仅 `FRONTEND_URL` + `CORS_EXTRA_ORIGINS`；内网/localhost 调试源仅非生产放行 |
| 输入校验 | Joi | 请求参数 Schema 校验 |
| 并发保护 | 事务 + 行锁 | `SELECT ... FOR UPDATE` 防止竞态（冲正/还款） |

### 认证接口 (`/api/v1/auth`)

| 方法 | 路径 | 鉴权 | 说明 |
|------|------|------|------|
| GET | `/auth/handshake` | 否 | 预握手，交换 AES 密钥 |
| POST | `/auth/login` | 否 | 用户登录（前置 Joi 校验 + 账户锁定检查） |
| GET | `/auth/check-admin` | 否 | 检查是否已存在管理员（首次注册前调用） |
| POST | `/auth/admin-register` | 否 | 管理员首次注册（仅可注册一次） |
| POST | `/auth/refresh` | 否 | 刷新 Token |
| POST | `/auth/logout` | 否 | 登出（**刻意不挂 authGuard**：令牌已失效时也要能幂等登出） |
| GET | `/auth/me` | JWT | 获取当前用户信息 |
| POST | `/auth/lock-system` | JWT | 锁定当前会话 |
| GET | `/auth/login-logs` | JWT | 获取当前用户登录日志（最近 30 条） |

> ⚠️ `POST /auth/register` **未挂载**（`src/modules/auth/api/index.js:13` 为注释行），
> 用户注册已由「管理员首次注册 + 后台建号」取代；历史文档中列出该接口属过期信息。

### 安全接口 (`/api/v1/security`)

| 方法 | 路径 | 鉴权 | 说明 |
|------|------|------|------|
| GET | `/security/pin/check` | JWT | 获取 PIN 状态 |
| POST | `/security/pin/verify` | JWT | 验证 PIN 码 |
| POST | `/security/pin/route-verify` | JWT | 风险路由 PIN 验证，成功后返回一次性 token（`x-route-verify-token`） |
| POST | `/security/pin/set` | JWT | 设置 PIN 码 |
| POST | `/security/pin/change` | JWT | 修改 PIN 码 |
| POST | `/security/pin/reset` | JWT | 重置 PIN 码（已挂载，前端暂未调用） |
| POST | `/security/risk-report` | JWT | 设备风险信号上报（纯信号落库，不拒服务） |

### 用户接口 (`/api/v1/user`)

> 该模块所有路由均先挂 `authGuard`（`router.use(authGuard)`）。

| 方法 | 路径 | 说明 |
|------|------|------|
| PUT | `/user/profile` | 更新用户资料 |
| POST | `/user/email/send-code` | 发送邮箱验证码（频率限制中间件 + Joi 剥离伪造字段） |
| PUT | `/user/email/change` | 修改邮箱（需验证码） |
| PUT | `/user/password/change` | 修改密码（需邮箱验证码） |

## 银行卡业务规则

### 账单周期计算

- **账单周期**: 账单日(bill_day)次日 ~ 次月账单日前一天
- **账单月归属**:
  - 消费日期 **≤** 账单日 → 当月账单（账单日当天仍属当月）
  - 消费日期 **>** 账单日 → 下月账单（开启新周期）
- **还款日**: 账单月的下一月 repayDay
- **逾期判定**: 当前日期 > repay_date 且 need_repay > 0

### 信用卡冲正规则

- 消费冲正: 原支出 → 冲正收入 + 恢复账单额度
- 还款撤销: 原还款 → 冲正收入（恢复余额）+ 软删除还款记录 + 全量重建账单
- 账单周期隔离: 冲正/还款检查仅限同一 `bill_month`，不跨周期误拦
- 并发保护: 事务内 `SELECT ... FOR UPDATE` 行锁，防止重复冲正

### 举例说明（账单日=12号，还款日=次月6号）

| 消费日期 | 归属账单月 | 出账日 | 还款日 |
|---------|-----------|--------|--------|
| 4月1日 ~ 4月12日 | 4月 | 4月12日 | 5月6日 |
| 4月13日 ~ 4月30日 | 5月 | 5月12日 | 6月6日 |

## 技术栈

| 类别 | 技术 | 用途 |
|------|------|------|
| 框架 | Express 4.19.2 | HTTP 服务框架 |
| 数据库 | MySQL (mysql2/promise) | 连接池，连接数 10 |
| 认证 | jsonwebtoken 9.0.2 | JWT Token 签发与验证 |
| 密码加密 | bcryptjs 2.4.3 | 单向哈希密码存储 |
| 安全头 | helmet 7.1.0 | HTTP 安全头 |
| 跨域 | cors 2.8.5 | 白名单 CORS 配置 |
| 日志 | morgan 1.10.0 | HTTP 请求日志 |
| 校验 | joi 17.9.2 | 请求参数 Schema 校验 |
| 文件上传 | multer 1.4.5-lts.1 | 多文件上传中间件 |
| 图片处理 | sharp 0.33.0 | WebP 转换 + 缩略图生成 |
| 环境变量 | dotenv 16.4.5 | .env 配置加载 |
| 邮件 | nodemailer 6.9.13 | 邮件发送 |
| 数据库备份 | mysqldump 3.2.0 | 数据库导出 |
| 压缩 | adm-zip / archiver | ZIP 归档 |
| 测试 | Jest 29.7.0 | 单元测试 / 集成测试 |
| 热重载 | nodemon 3.1.0 | 开发模式自动重启 |
| HTTP 客户端 | axios ^1.16.1 | 外部服务与 AI 供应商请求 |
| 会话 | express-session ^1.18.0 | 会话支持 |
| 其他 | nanoid, uuid, crypto-js, dayjs | ID 生成、加密与日期处理 |

版本为当前 `package.json` 声明，具体安装版本以锁文件及实际依赖为准。

## 快速开始

需要 **Node.js 22.12+（或 24）、npm、MySQL 8**。以下命令在 `api/` 根目录执行，完整配置与生产对齐见 [ENV_SETUP.md](ENV_SETUP.md)。

### 安装依赖

```bash
npm install
```

### 配置环境变量

```bash
# 仅首次、.env 不存在时复制；已有配置只补缺项，不覆盖密码和密钥
cp -n .env.example .env
```

主要配置项（模板或代码回退，不等于当前部署值）:

| 变量 | 说明 | 默认值 |
|------|------|--------|
| `PORT` | 模板显式设为 7788，与 Web 配套；启动检查要求填写（代码历史回退 3001） | 7788（模板） |
| `NODE_ENV` | 运行环境（`production` 会触发密钥 fail-fast 与错误脱敏） | development |
| `DB_HOST` / `DB_PORT` | 数据库主机 / 端口 | localhost / 3306 |
| `DB_USER` / `DB_PASSWORD` | 数据库用户 / 密码 | root / (空) |
| `DB_NAME` | 数据库名 | live |
| `TRUST_PROXY_HOPS` | 反代层数：直连填 0，一层 nginx 填 1；显式留空不信任，未配置时代码回退 1 | 0（模板） |
| `JWT_SECRET` | JWT 签名密钥。**生产必填**，≥32 位随机串，占位值/过短会拒绝启动 | (必填) |
| `JWT_EXPIRES_IN` | Access Token 有效期 | 7d |
| `JWT_REFRESH_EXPIRES_IN` | Refresh Token 有效期 | 30d |
| `SHARE_TOKEN_SECRET` | 分享 token 密钥，未配置时回退 `JWT_SECRET` | (可选) |
| `FIELD_ENCRYPT_KEY` | 字段级加密密钥（device_crypto 握手行 aes_key 落库加密），未配置时从 `SHARE_TOKEN_SECRET` 派生 | (可选) |
| `RSA_KEY_FILE` | RSA 密钥对持久化路径 | `data/rsa-keys.json` |
| `BCRYPT_SALT_ROUNDS` | bcrypt 盐轮数（10 约 100–200ms，生产建议 12–15） | 10 |
| `FRONTEND_URL` | 前端地址 | (必填，用于 CORS) |
| `CORS_EXTRA_ORIGINS` | 额外允许的跨域来源，逗号分隔（生产用） | (空) |
| `APP_NAME` | 应用名称（邮件标题等） | 生活管理系统 |
| `EMAIL_HOST` / `EMAIL_PORT` | 邮件服务器（465=SSL，587=STARTTLS） | smtp.gmail.com / 587 |
| `EMAIL_USER` / `EMAIL_PASS` | 发信账号 / 授权码 | (空) |
| `AMAP_KEY` | 高德 Web 服务 Key（IP 定位、逆地理编码） | (空) |
| `IPINFO_TOKEN` | ipinfo.io Token（IP 定位国际回退，可选） | (空) |
| `REQUIRE_CLIENT_NONCE` | 设为 `true` 强制要求 `x-client-nonce` 头（三端需同步携带） | false |
| `TOKEN_MAX_SESSION_DAYS` | 会话最长天数，超期强制重登 | 90 |
| `INIT_ENABLE` | 启用全量初始化 | false |
| `INIT_SKIP` | 跳过初始化 | false |
| `INIT_ADMIN_USER` / `INIT_ADMIN_PASS` / `INIT_ADMIN_EMAIL` | 初始管理员账户（仅 `INIT_ENABLE=true` 时生效） | admin / (必填) / admin@example.com |
| `INSTALLMENT_GRACE_DAYS` | 分期宽限天数（超期未入账则作废） | 30 |
| `INSTALLMENT_SCAN_INTERVAL_MS` | 分期定时扫描间隔（毫秒） | 6 小时 |

#### AI 配置与预算

- **先启动基础服务**：模板 `AI_MODE=disabled`。需要 AI 时改为 `deepseek`（兼容开关名，不限定实际接入商），按 [数据库说明](mysql/README.md) 配齐 `AI_DB_HOST/PORT/NAME/USER/PASSWORD`；`AI_DB_NAME` 必须与 `DB_NAME` 同库，账号必须独立只读，不能复用 root 或业务写账号。
- **连接配置**：用户在「聊天设置 → AI 连接设置」填写地址、模型、Key，保存到加密的 `ai_provider_profile`。旧 `AI_API_KEY/AI_BASE_URL/AI_MODEL/DEEPSEEK_*` 不是当前用户聊天配置入口。
- **额度与时限**：本人设置 > 数据库 `ai_config` > env > 代码缺省。当前五项站点初始值与可调范围见 [AI 额度说明](src/modules/ai/README.md#用户额度与超时2026-11-13)；既有数据库非空配置会保留，不用 `.env.example` 的低额度回退描述实际运行上限。
- **联网搜索**：站点代配 `AI_SEARCH_BASE_URL/API_KEY/PROVIDER` 三项同填或全空；DeepSeek/智谱可复用聊天连接 Key。无论来源如何配置，仍需用户开启联网并具备有效会话 `webSearch` 子授权；有配置不等于获得调用或计费授权。
- **密钥保护**：已有部署保留 `JWT_SECRET`、`SHARE_TOKEN_SECRET`、`FIELD_ENCRYPT_KEY` 和 RSA 文件。直接换密钥会影响既有设备握手及 AI 凭据、记忆/回执密文；多实例应保持一致。

完整可选项及检查方式以 [.env.example](.env.example) 和 [ENV_SETUP.md](ENV_SETUP.md#ai-配置) 为准。

#### APP 签名自检（P1-28）

| 变量 | 说明 | 默认值 |
|------|------|--------|
| `APP_SIGN_SHA256` | APK 签名证书 SHA-256 白名单（64 位 hex，逗号分隔可多签共存）。未配置=守卫不启用 | (空) |
| `APP_SIGN_ENFORCE` | `loose`=只校验带头的请求（兼容浏览器）/ `strict`=连浏览器也要求带头（仅纯 APP 部署） | loose |

#### 安全风控开关（均有安全默认值，不改即为最严格）

| 变量 | 说明 | 默认值 |
|------|------|--------|
| `PIN_RISK_MODE` | PIN 风控模式：`enforce` 严格拦截 / `observe` 只告警不拦截 / `off` 完全关闭 | **enforce** |
| `PIN_RISK_FREQ_LIMIT` | 全局频率上限（次） | 60 |
| `PIN_RISK_FREQ_WINDOW` | 全局频率窗口（秒） | 60 |
| `PIN_RISK_SENSITIVE_LIMIT` | 敏感操作（POST/PUT/PATCH/DELETE）上限（次） | 10 |
| `PIN_RISK_SENSITIVE_WINDOW` | 敏感操作窗口（秒） | 60 |
| `PIN_PASS_WINDOW` | PIN 验证成功后的放行窗口（秒） | 30 |
| `PIN_NONCE_MODE` | nonce 校验模式：`enforce` 拦截 / `observe` 只告警 / `off` 关闭 | **enforce** |

> - 非 `enforce` 模式会在启动日志打印显式告警，避免「以为在严格模式、实际没生效」。
> - `observe` 模式的留痕检索关键字：`[pinSecurityGuard][observe]`、`[securityCheck][observe]`。
> - `PIN_RISK_*` / `PIN_PASS_WINDOW` 的默认值与历史实现完全一致，不配置即无行为变化。

> ⚠️ `APP_SECURITY_SALT` 已于 2026-09-21 移除：它只被一份**无人加载的死代码**引用，
> 运行时从未校验过请求签名。详见 `logs/CHANGELOG_2026-09-21.md`。
> 生成强随机密钥：`openssl rand -hex 32`

### 创建数据库

以下建库和导入命令**仅用于新库**，库名应与自己的 `DB_NAME` 一致。已有库不要重复导入完整 SQL，正常启动执行增量迁移即可。

```sql
CREATE DATABASE live DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
```

### 导入数据库结构

```bash
mysql -u root -p live < mysql/live.sql
```

### 检查环境与启动服务

```bash
# 无数据库副作用；--db 额外执行 SELECT 1 检查连接
npm run env:check
npm run env:check -- --db

# 开发模式（nodemon 热重载）
npm run dev

# package.json 中 start 与 dev 相同，非生产守护
npm start
```

> 生产环境建议直接用 `node app.js` 交给进程守护（pm2/systemd），不要用 nodemon。从 API 根目录启动；进程环境变量优先，`NODE_ENV=production` 不会自动改读 `.env.production`。

服务启动过程:
1. 启动前检查必填配置、端口、地址、密钥及 AI 条件，错误则退出。
2. 启动监听后检查数据库连接，并执行增量迁移；`INIT_ENABLE=true` 时执行深度初始化。迁移失败默认退出，不能用跳过开关掩盖结构问题。
3. 注册分期定时扫描，输出实际端口及启动信息。

模板配置访问：[API 地址](http://localhost:7788/api/v1)、[服务探活](http://localhost:7788/api/health)。探活只说明进程可响应，不代表数据库、迁移、AI 或完整业务已通过验收。实际以自己的 `PORT` 为准；Go 默认监听 7777，两端可并行对照，但 Go 不含当前 Node AI 能力。

### 运行测试

```bash
npm test                    # 默认 Jest 单元/集成及离线评测，不含独立真实套件
npm run test:unit           # tests/unit
npm run test:integration    # tests/integration（目录已存在）
npm run test:coverage       # 覆盖率报告输出到 coverage/
npm run test:env            # 配置检查工具回归
npm run test:money          # 金额精度与资金边界回归

npm run ai:capabilities:check # 工具定义、校验与执行分发接线检查
npm run test:ai             # AI、计算、搜索和公共边界离线回归；自动先跑能力检查
npm run test:ai:v3          # V3 编排、预算与 HTTP 契约
npm run test:ai:shared      # 共享读层、预览、动作、guard 与显式历史 fixture
```

默认配置匹配 `.test.js` / `.spec.js`；真实 MySQL/供应商 `.realtest.js` 与 live 评测 `.evaltest.js` 分别使用独立配置。默认离线测试中的历史 fixture 不代表旧生产入口仍开放。

| 独立入口 | 范围与注意事项 |
|---|---|
| `npm run test:ai:real` | `tests/real/` 的隔离 MySQL/HTTP 测试；真实供应商另有门控，先读测试说明，不在正式库做验收写入 |
| `AI_EVAL_LIVE=1 npm run test:ai:eval:live` | 真实供应商黄金评测，会产生调用与费用；先确认授权、目标模型及隔离数据，报告写入工作区 `temp/api-logs-archive/ai-eval/` |
| `npm run env:check:example` | 检查源码使用的环境变量是否纳入模板，不连库、不调用模型 |
| `npm run ai:memory:backup -- backup <源目录> <新归档>` | 加密备份；另支持 `verify <归档>`、`restore <归档> <新目录>`。记忆与个性化需分别归档、配套恢复，先读运行手册 |
| `npm run mock:db` / `npm run mock:db:verify` | 独立 Mock 数据生成与校验，参数及输出位置见 `tools/mock/README.md`；生成不等于导入或切换运行库 |

具体前置条件见 [测试说明](tests/README.md)、[黄金评测说明](tests/eval/README.md) 和 [试行手册](../Docs/docs/ai/trial-runbook.md)。本项目没有 npm `build` 脚本。

## 系统初始化机制

系统启动时通过 `src/init/` 模块自动处理数据库初始化:

| 模式 | 环境变量 | 行为 |
|------|---------|------|
| 增量 | 默认 | 执行 `migrations/` 目录下未执行过的迁移脚本 |
| 全量 | `INIT_ENABLE=true` | 先执行全量 SQL 备份，再同步表结构，最后跑迁移 |
| 跳过 | `INIT_SKIP=true` | 完全跳过初始化，用于排查问题 |

## 代码架构约定

### 模块分层

常见业务模块采用以下分层，按实际职责增减目录，不要求每个模块都有完整四层:

```
modules/{模块名}/
├── api/index.js        # 路由注册（Express Router）
├── controller/index.js  # 控制器（请求处理、参数提取、响应格式化）
├── model/index.js       # 数据模型（SQL 查询、事务管理）
└── rules/index.js       # 校验规则（Joi Schema）
```

### 统一响应格式

多数业务接口使用 `res.say(message, statusCode)` 返回统一信封，业务对象位于 `message` 中:

```json
{
  "status": 200,
  "message": {
    "items": []
  }
}
```

错误时 `message` 为错误描述字符串；非开发环境的服务器异常统一脱敏。握手、探活、静态资源和 AI SSE 等入口有各自协议，不能一概按此 JSON 示例解析，具体以路由实现及 AI 契约为准。

---

## 更新日志

新增记录按日期合并，以下近期入口以实际日记为准；表内更早的项目保留各轮历史范围。

| 日期 | 内容 |
|------|------|
| 2026-11-13 | [主 README 目录/入口更新、环境配置、AI 个性化、重启恢复、试行基础与阶段性收尾](logs/CHANGELOG_2026-11-13.md) |
| 2026-11-12 | [大范围查询、正文图表、实时思考、待补恢复、数字证据门与 Mock 数据库](logs/CHANGELOG_2026-11-12.md) |
| 2026-11-11 | [V3 服务拆分、旧编排清理、聊天模块化、传输恢复与业务卡片收口](logs/CHANGELOG_2026-11-11.md) |
| 2026-11-10 | [AI 一阶段加固、进程/供应商验收、跨设备同步、请求准入与能力计划](logs/CHANGELOG_2026-11-10.md) |
| 2026-11-09 | [工具参数单次恢复、模型能力schema、多主体独立范围与记忆写后读取](logs/CHANGELOG_2026-11-09.md) |
| 2026-11-09 | [展示数量与查询意图隔离、中文日期末端完整承接](logs/CHANGELOG_2026-11-09.md) |
| 2026-11-09 | [日收入极值 incomeDesc、queryId一致性与保存状态日期语义](logs/CHANGELOG_2026-11-09.md) |
| 2026-11-09 | [AI数据集能力表实施、有效参数反馈、卡任务承接与真实模型/页面验收](logs/CHANGELOG_2026-11-09.md) |
| 2026-11-09 | [AI数据集能力表计划按评审修订为v2：阶段A改为保持现有行为的兼容重构，补齐财务第二校验、输入/执行/元数据三层与单向依赖、独立契约回放、自纠预算与有效参数来源；仅文档](logs/CHANGELOG_2026-11-09.md) |
| 2026-11-09 | [AI数据集能力表计划评审：兼容约束冲突、财务第二校验入口、输入与有效元数据分层、独立回放验收及自纠预算；仅文档留档](../temp/api-logs-archive/REVIEW_2026-11-09_AI_DATASET_CAPABILITIES.md) |
| 2026-11-08 | [失败请求级诊断与离线回放：direction误拒根因、记录到的工具参数、跨月累计与月份粒度差异、最近N个月范围及全量回归1787项](logs/CHANGELOG_2026-11-08.md) |
| 2026-11-08 | [AI长期记忆与历史承接：用户隔离Markdown、历史原话回查、预算化近期上下文、保存回执一致性和离线安全验证](logs/CHANGELOG_2026-11-08.md) |
| 2026-11-08 | [财务查询上下文、范围与数量修复：SQL先筛选与全范围极值、查询实例及图表绑定；API1541、真实模型连续追问与页面验收](logs/CHANGELOG_2026-11-08.md) |
| 2026-11-08 | [口语三笔记账金额引用、账户追问及会话续接：真实失败包离线回放、API1625项通过；追加后端控制台推理输出，新增真实模型调用0](logs/CHANGELOG_2026-11-08.md) |
| 2026-11-08 | [助手分析质量只读诊断：真实数量比例更正被删正文/丢图、候选语义与任务状态缺口及实施顺序；真实模型调用0](../temp/api-logs-archive/AI_REASONING_QUALITY_DIAGNOSIS_2026-11-08.md) |
| 2026-11-07 | [V3交付：AI自主选工具、受控数据回灌推理、单一聊天入口与人工确认入库；27真实场景及移动端隔离验收、失败复测与日志证据](logs/CHANGELOG_2026-11-07.md) |
| 2026-11-07 | [V3独立安全复核：有限结果声明校验、当前授权引用保留、事务回滚及方向标量边界；184条独立重复验证与准确限制](logs/ai-v3-2026-11-07/SECURITY_REVIEW.md) |
| 2026-11-07 | [口语记账续句修复：同候选零模型续写、旧失败重核、跨会话绑定与真实原话；API1257/Web130、54个独立HTTP/MySQL场景与实际移动页面通过](logs/CHANGELOG_2026-11-07.md) |
| 2026-11-07 | [原续句错误定位与失败证据：余额支付被判account，供应商成功后API业务403；已修复](../temp/api-logs-archive/AI_FOLLOWUP_SCOPE_DIAGNOSIS_2026-11-07.md) |
| 2026-11-07 | [AI移动端紧凑布局与最终复核：正文13px、输入区88px、金额可信口径、OCR原子取消恢复、API1206/Web121及实际页面证据](logs/CHANGELOG_2026-11-07.md) |
| 2026-11-07 | [AI可靠性：OCR离页取消与事务恢复、流式120秒总时限、脱敏错误链路及专项/物理故障验收](logs/CHANGELOG_2026-11-07.md) |
| 2026-11-07 | [AI规整与66场景独立对话实测：API1194、真实模型/数据库/页面、供应商耗时及脱敏日志、正式26表无变化与未验子项](logs/CHANGELOG_2026-11-07.md) |
| 2026-11-07 | [AI当前版本独立审查：10项AI问题、连接/授权迁移、多笔回执及本轮测试与离线复现](../temp/api-logs-archive/AI_REVIEW_2026-11-07.md) |
| 2026-11-06 | [AI业务开放规划：三子代理、24需求/22任务、决策与来源溯源](logs/CHANGELOG_2026-11-06.md) |
| 2026-11-06 | [今日合并日志：认证401排查、金额精度、AI表迁移、真实联调、OCR与聊天交互精简](logs/CHANGELOG_2026-11-06.md) |
| 2026-10-13 | 冗余接口清理：整组删除 `/bank`、`/bank-category`、`/resource`、`/database`，并删除 `/user/settings` 等零散接口（启用路由 192→165）；`/user/email/send-code` 补上 Joi validator。见 `src/api/index.js:50-52` 注释 |
| 2026-10-12 | 修复 httpOnly Cookie 通道下 PIN 风控对 web **静默失效**（`pinSecurityGuard` 改认 Cookie 令牌，与 `extractToken` 双通道对齐） |
| 2026-10-08 | P0-5：认证 token 改为 httpOnly Cookie（新增 `cookieParser.js`）；P1-18：`TRUST_PROXY_HOPS` 收敛 XFF 信任（见 `src/common/middleware/cookieParser.js`、`app.js:59-65`） |
| 2026-09-21 | [安全审计：APP 接入站点信任模型 + securityCheck 死代码与签名能力缺失](logs/CHANGELOG_2026-09-21.md)（**无代码改动**，见归档 [APP-接入站点安全设计.md](../temp/GO/APP-接入站点安全设计.md)） |
| 2026-09-20 | [PIN 安全验证：锁定绕过修复 + 前端策略同步至 webview-APP 与 APP](logs/CHANGELOG_2026-09-20.md) |
| 2026-09-14 | [Vant 组件安卓原生复刻工程（APP/）](logs/CHANGELOG_2026-09-14.md) |
| 2026-06-28 | [多项模块优化与修复](logs/CHANGELOG_2026-06-28.md) |
| 2026-05-31 | [信用卡冲正 + 账单一致性修复](logs/CHANGELOG_2026-05-31.md) |
| 2026-05-29 | [定位模块 + 邮箱脱敏](logs/CHANGELOG_2026-05-29.md) |
| 2026-05-28 | [新增模块 + 文档补全](logs/CHANGELOG_2026-05-28.md) |
AI 新增业务、范围授权和防循环的历史实现：[2026-11-06 实施与验收日志](logs/CHANGELOG_2026-11-06.md)。当前文字聊天统一为 V3，新生产能力需显式启用；当前入口见 [V3 说明](src/modules/ai/README.md)。

### 历史补记：2026-11-08 分析质量修复

任务承接、卡片数量饼图、可信派生统计、候选语义筛选与待补整批续接：[变更与离线验收](logs/CHANGELOG_2026-11-08.md)。使用真实保存响应离线回放，未调用付费模型，服务沿用 5173/7788。

验证：后端 85 套 / 1778 项、前端 AI 123 项全部通过，实际 Vue 图表组件渲染通过。

### 历史补记：2026-11-13 试行基础与阶段收尾

> **2026-11-13 AI扩展与试行基础**：工具注册与实际分发门禁、服务端灰度名单、生产DB准入6/min、记忆加密备份与恢复，以及V3兼容规范已实施。API232套/5266项通过，新真库专项3项和真实记忆恢复演练通过；真实模型回测交下一执行者，未宣称新的8/8或生产发布。见 [变更记录](logs/CHANGELOG_2026-11-13.md)、[回归交接](../temp/api-logs-archive/ai-foundation-20261113-7d2c/HANDOFF.md)、[运行手册](../Docs/docs/ai/trial-runbook.md)。

> **2026-11-13 第一阶段已阶段性收尾**：独立核对API232套/5266项、Web501项、隔离真库10项与商汤原8场8/8；当前运行时代码与回测冻结版本一致。两目录备份恢复完成；32次主对话与额外1次未完成画像尝试分开登记，证明边界见 [阶段收尾](../temp/api-logs-archive/ai-stage1-closeout-20261113/STAGE1_CLOSEOUT.md)。搜索真源、生产和进一步能力扩展另行开展。

