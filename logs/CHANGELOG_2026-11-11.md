# 2026-11-11 变更日志（合并）

> 本文件由当日独立日志按日期合并，来源见各节标题。

---

## 来源：CHANGELOG_2026-11-11_AI_AUTHORIZATION_CONTINUATION.md

# 授权续跑误失败与重复气泡修复（2026-11-11）

## 问题与真实日志

用户反馈：提交授权后，前端马上出现两条“这条回复没有成功”，后台仍在执行模型对话。
本轮只读核对真实调用日志、消息记录和请求回执，未修改历史业务数据。

上海时间的代表链路：

| 时间 | 记录 | 结果 |
| --- | --- | --- |
| 12:54:06 | 授权前请求 `d5887b34…`、消息 2726 | `AI_GRANT_REQUIRED`，等待 read 授权 |
| 12:54:09–12:54:18 | 续跑请求 `583a0065…`、消息 2728 | 两次模型调用，整轮 completed，原话一致 |
| 15:20:28 | 请求 `35a8bd5f…`、调用日志 5376、消息 2752 | `AI_GRANT_REQUIRED`，等待 operate 授权 |
| 15:20:31–15:21:06 | 续跑请求 `bb001fc6…`、调用日志 5377/5378、消息 2754 | 模型返回 ok；最终输出缺少 `proposal.kind`，使用未开放的 `proposal.action`，整轮 `AI_INVALID_RESULT` |

因此，后台继续执行的反馈属实。最后一条链路存在真实结构校验失败；模型接口成功不能替代整轮成功回执。本轮保留结构和效果校验。

## 根因

1. 前端原地继续授权消息，只更换 `requestId`，保留了旧 `messageId`。同步以消息编号或请求编号匹配，旧授权失败快照可以覆盖新请求的身份、pending 和 turn 状态；新请求的活动随后又追加气泡。
2. 仅清除旧消息编号仍会让旧请求的历史和活动重新插入。需要同时关联被继续的旧请求、对应用户消息和助手消息。
3. 授权失败活动不含完整授权请求对象，历史未到时被当作普通失败。回执、历史和实时错误的授权状态也需要一致。
4. 仅在内存保存旧请求关联，刷新或跨设备恢复会让旧授权再次出现。
5. 后端活动镜像仍按活动自身死线超时，即使真实请求的运行租约有效，或请求已经完成。

## 修复

- `web/src/views/AI/assistant/composables/useAssistantTurn.js`：继续请求清理旧消息身份与授权/失败字段，用户与助手同时关联旧请求；流事件及 finally 校验原请求身份。已授权子请求失败后，重试先只读核对持久化失败，再继续关联链。
- `web/src/utils/aiConversationSync.js`：请求编号优先匹配；吸收被继续请求的旧快照；远端继续请求替换原气泡并接管身份；本机流仅持有自己的运行状态。
- `useAssistantAuthorization.js`、`useAssistantSync.js`、`useAssistantArtifacts.js`、`aiBusinessHistory.js`、`aiTurn.js`：授权等待与真实失败分开；成功清理旧授权字段；显式关联折叠历史和活动，不凭相同原文合并独立请求。
- `useAssistantJournal.js`：本地未完成请求保存继续关联；刷新恢复保留原话、会话与请求身份，包括回执读取网络失败的路径。
- `web/src/utils/api/ai.js`、`aiBusinessContract.js`：透传 `retryOf`；校验 `retryOf`、`continuedBy`、`retryLinks`，拒绝循环和冲突关系，防止坏关联隐藏消息。
- `api/src/modules/ai/service/conversations.js`：`claimRetry` 在对话事务锁内核验同用户、同会话、同原话的已保存失败父请求，原子登记 `continuedBy`。同旧父只能继续一次。新成功/失败消息保存 `retryOf`；投影明确关系。
- `v3Service.js`、`v3ResultAssembly.js`：准入后、模型调用前认领父请求；无效关联不产生模型调用或伪关联历史；已完成同请求仍回放原回执。
- `conversationSync.js`：每次返回所有者隔离的 `retryLinks`，使低于游标的旧父更新及续跑期间刷新也可恢复关联；仅无回执行时按活动死线兜底，已完成回执覆盖旧活动。

关系使用已有消息 meta JSON，无数据库结构迁移。旧版本历史没有明确关联时不按原文猜测补写关系。

## 验证

- 前端初始 3 个新增复现：修前全部失败，分别生成 3/5 条消息以及错误的 failed 状态；修后通过。
- 后端活动租约 3 个复现：修前全部误判 failed，修后通过。
- 已覆盖旧回声已/未同步、旧活动先到、终态快照先/后于流、运行期刷新、回执网络失败、跨设备继续和旧流晚到、子失败立即重试、循环/冲突关系及独立同原话请求。
- 后端定向 8 套 119 项、核心补充 4 套 164 项通过（有重叠，不相加）；真实请求防护的授权→续跑→同请求回放验证调用次数不增加。
- 完整回归和最终构建的结果补记于下方。证据在 `temp/ai-authorization-race-20261111/`。

## 最终集成验证

- Web：`npm run test:ai` **230/230** 通过，`npm run build` 通过。
- API：最终 `npm test -- --runInBand --silent` **212 套 / 4770 项全部通过**。
- 主代理最终授权/继续/持久化/同步定向回归 **6 套 / 73 项全部通过**。
- 独立复审确认连续子失败链、循环/冲突拒绝、Journal 网络恢复三项修复；对应 4 个回归通过。
- 开发服务核验：5173 返回 200 且正在提供包含 `retryOf` 的新前端模块；7788 由 nodemon 子进程运行，源文件变更已触发重载。

首次完整 API 回归曾为 211 套通过、1 套失败（4743 项通过、1 项失败）。失败为独立并行工作新加入的 tilde Markdown 示例声明校验；测试于 15:44:40 更新、对应 `v3Claims.js` 支持于 15:45:43 更新。本轮未修改该测试或声明校验，当前原样定向通过后重新执行完整集成回归，结果为上述 4770 项全通过。原始失败证据保留在 `api-regression.log`；最终证据为 `api-regression-final.log`、`api-targeted.log`、`web-ai.log` 和 `web-build.log`。

---

## 来源：CHANGELOG_2026-11-11_AI_BUSINESS_CARD_RESTORE.md

# AI 业务核对卡片恢复与收口（2026-11-11）

用户明确要求直接修复，随后实测反馈“已经看到核对卡片，而且已经成功推送”。本轮功能卡缺失问题已修复，完整回归与构建通过。既有未提交修改保留，没有提交或重置仓库。

## 实际原因与结果

模块化后的 `AssistantMessage.vue` 只渲染正文、图表、数据卡和 `operationOutcome` 提示，遗漏了已有业务卡组件及其事件接线。后台确实生成了日记提案，实时结果与历史恢复也保留完整产物；有产物时清空模型说明文字是既有呈现规则，但缺少卡片使页面只剩“生成时状态”，无法核对与提交。

这次缺陷是前端漏渲染与事件接线，不能归因于草稿路由错误或用户未授权。此前手机传输验收覆盖传输、恢复和消息归属，未覆盖完整业务卡 UI 操作；本轮补上真实 SFC、controller 与业务组件的回归，保留最初 0/2 的红反例及修复后 2/2 结果。

`operationOutcome` 是生成时快照，其中 `formalWriteExecuted=false` 与产物 pending 可以和用户后来提交后的当前 committed 状态并存；当前是否提交应核对产物的最新状态，不能仅据生成时快照判断。

另一个独立问题是模型把“当前待核对为 0”说成“从未生成过”。本会话只读统计确认生成过 2 个产物，日记与交易草稿均已有提交回执，所以当前待核对为 0。该状态回答现以本人当前会话的真实存档聚合为准。

## 变更

| 范围 | 最终行为 |
| --- | --- |
| `web/src/views/AI/assistant/components/AssistantMessage.vue`、`web/src/views/AI/Assistant.vue` | 恢复 `AiProposalCard`、单/多交易 `AiDraftCard`、`AiOcrCard`、`AiFinancialCheckCard`，把 change、working、核验、生成草稿、取消与恢复事件接回 controller。 |
| `web/src/components/ai/AiProposalCard.vue` | 卡片卸载立即归还工作锁；卸载后的确认弹窗及异步结果不能继续执行或更新消息。 |
| `web/src/views/AI/assistant/composables/useAssistantArtifacts.js`、`useAssistantSync.js`、`web/src/views/AI/assistant/useAssistantController.js` | 按消息、产物身份及版本更新。候选迟到查询不能覆盖新草稿或复活旧候选；候选操作挂起时切换、删除、卸载会话立即释放旧锁，旧结果与 finally 不影响新会话或新动作。 |
| `api/src/modules/ai/service/conversationArtifacts.js`、`v3Service.js`、`v3ResultAssembly.js` | 明确追问草稿/提案数量或状态时，先校验授权，再聚合本人当前会话的交易草稿及业务提案；区分累计生成、待确认、已提交、过期与其他状态。最终结果事务内刷新统计，纠正虚假零数量答复。 |
| `web/tests/aiAssistantUi.test.mjs`、`web/tests/aiAgent.test.mjs`、`api/tests/unit/aiConversationArtifacts.test.js` | 补真实业务组件操作、候选迟到与退出会话控制、草稿数量真值及授权边界回归。 |

状态读取只提供种类、状态与数量，不披露草稿正文或内部 ID。普通闲聊、新文章写作不预读草稿状态；未授权保持授权门控，读取失败保持未知，不能编造 0。已提交和已过期记录保留累计生成数量，过期记录不恢复为可提交。没有新增分类模型调用或放宽业务授权。

## 用户实测与只读证据

会话 `2ab7a578-f8bd-40b2-8581-758e40e19355`：

| 产物 | 只读确认 |
| --- | --- |
| 李白生平日记，`diary.create` 提案 `166a22b1-4208-472d-8b2e-dd481d84931e` | 初始 pending，正文完整；用户操作后 committed / version 3。生成请求为 `4dd0536e-bb23-436a-9eb2-c412e42463a1`。 |
| 买菜 20 元，交易草稿 `df0bd215-b7c6-496a-8251-1455afe260f0` | 最新聚合状态 committed。 |
| 当前会话聚合 | createdCount=2、awaitingConfirmationCount=0；两类各 1 个 committed。 |

证据：[初始记录](../../temp/ai-business-card-render-20261111/latest-card-readonly.initial.json)、[日记提交后记录](../../temp/ai-business-card-render-20261111/latest-card-readonly.committed.json)、[最终真实聚合](../../temp/ai-business-card-render-20261111/artifact-state-readonly.json)。聚合证据包含 3 次 SELECT、0 写入、0 模型调用。

实际提交由用户自行操作。代理没有重复生成、延长 TTL、点击真实提交或写入正式业务库与正式 memory，也没有新增付费调用或修改 `.env`、模型、额度配置。用户反馈与只读状态构成这次实际成功证据；离线 UI 测试不冒充代理真实浏览器提交验收。

## 最终验证

| 验证 | 最终结果 |
| --- | --- |
| API 既有审计清单加全部当前 AI 测试 | 215 套 / 4833 项通过，0 失败；2026-11-11 17:31:07 完成。 |
| Web 全部当前 AI 测试 | 19 个文件 / 342 项通过，0 失败、取消或跳过；2026-11-11 17:38:55 完成。 |
| Web 生产构建 | 通过；既有 chunk 大小与 Browserslist 数据时效提示不阻断构建。 |
| 源码与 fixture 指纹 | API 486 份、Web 239 份，各自验证前后稳定；17:39:53 再次核对当前源码与最终已验版本完全一致。 |
| 真实 SFC/controller/业务卡定向 | 27/27，外部 API、确认弹窗与图表视觉使用内存替身；覆盖编辑、核对、明确确认、内存执行回执及恢复。 |
| 候选同步和动作归属定向 | 两套 143/143；两组永久控制均遍历 create/cancel/recover，覆盖永挂、远端删除及旧 finally 不清新锁。 |
| 后端草稿状态定向与独立复核 | 9 套 / 298 项、状态独立复核 18/18；真实 proposal store→result→history→Web validator/restore 离线契约回放通过。 |

定向结果是完整回归的补充证据，不与全量计数相加。API 最终验证后的前端边界修补未改 API，已通过最后指纹核对确认。

最终版本证据：[合并验证摘要](../../temp/ai-business-card-render-20261111/verification-final.json)、[API 摘要](../../temp/ai-business-card-render-20261111/api-verification-final.json)、[Web 摘要](../../temp/ai-business-card-render-20261111/web-verification-final.json)。同目录保存完整日志、测试清单和前后 SHA-256；`verify-api-final.ps1`、`verify-web-final.ps1` 可复跑。

定向详情：[业务卡复核](../../temp/ai-mobile-transport-audit-20261111/BUSINESS_CARD_CLOSEOUT.md)、[独立复核](../../temp/ai-mobile-transport-audit-20261111/FINAL_INDEPENDENT_REVIEW.md)、[状态契约冻结](../../temp/ai-mobile-transport-audit-20261111/artifact-state-closeout.json)。此前 [手机传输修复](CHANGELOG_2026-11-11_AI_MOBILE_TRANSPORT_FIX.md) 的 4815/323 基线与证据保持原样，不代替此次 4833/342 最终版本。

## 阶段

业务核对卡缺失事件已关闭，用户已完成当前日记与记账提交。核心架构继续处于发布候选验收阶段，这次已复现的卡片、候选同步和锁归属阻断均已关闭，无需为本次缺陷扩大架构重构。实体手机弱网、连续问答、断网/后台恢复与长 Markdown 复制的原有综合终验范围保留；单次卡片成功不等同于全部网络和全部业务场景验收完成。

---

## 来源：CHANGELOG_2026-11-11_AI_CHAT_LOGIC_MODULARIZATION.md

# 聊天页逻辑模块化执行记录（2026-11-11）

> 状态：**实现与验证完成**。
> Assistant.vue 从 1112 行降为 118 行，保留三个展示组件，新增十个功能 composables 与共享状态/controller/服务适配层。
> 原 62 项 aiAgent 行为断言保留；本轮新增 25 项回归，最终 test:ai 217/217 全通过。
> 此前完整套件基线为 192/192；本轮未测性能，不运行 build。

## 范围与交付

在 [逻辑结构评估](CHANGELOG_2026-11-11_AI_CHAT_LOGIC_REVIEW.md) 和
[模块化计划](PLAN_AI_CHAT_LOGIC_MODULARIZATION.md) 的边界上继续执行，
将父页剩余状态与运行流程按职责拆到 `web/src/views/AI/assistant/`。
此前 [A/B/C](CHANGELOG_2026-11-11_AI_CHAT_UX_POLISH.md) 的三个展示组件继续使用。
父页负责布局与 lifecycle，controller 负责组装，业务卡和既有纯工具保持原位置。

新增运行模块为 profile、images、activities、viewport、artifacts、authorization、turn、
journal、sync 和 conversation；各自按统一依赖注入签名使用所需状态和回调。
`assistantServices.js` 单独提供生产适配器，测试直接导入同一 controller 并替换服务。

按源码全部行数（包含空行）统计：

| 项目 | 行数/数量 |
| --- | ---: |
| Assistant.vue 本阶段改前 | 1112 |
| Assistant.vue 当前 | 118 |
| useAssistantController.js | 98 |
| assistantServices.js | 34 |
| createAssistantState.js | 58 |
| feature composables | 10 个 |
| 最大 feature：useAssistantTurn.js | 337 |
| 保留展示组件 | 3 个 |

父页减少 994 行。规模变化用于说明职责迁移，不是性能测量；
本轮没有渲染耗时、吞吐或内存基准，不能据此推断速度或内存改善。

## 状态与清理边界

- `createAssistantState` 创建每页唯一共享状态图，`messages`、`conversationId` 和全局 busy
  闸门不在其他模块复制。各功能只接收自己所需 refs，局部 timer、revision、请求控制器和游标由职责所属模块持有。
- `useAssistantX({ state, services, runtime, actions })` 显式列出模块依赖。
  controller 提供 `runtime.isActive()/nextId()` 并注入跨模块回调；功能模块没有循环 import。
- 全部模块创建后安装 journal 和 sync 的 watch，再让能力加载变更会话 ID。
  journal 先刷新旧会话草稿，再恢复新会话草稿、URL 和授权，保留原有顺序。
- controller 的独立 effectScope 覆盖状态和模块响应式效果。dispose 先使页面 runtime 失效，
  再中止请求、停止回执轮询与同步订阅、清 timer、关闭图片预览、移除 DOM 监听、
  停止 journal watch 并 flush 草稿，最后 scope.stop。
- 会话、授权、回执和快照异步完成后核验有效性、当前会话、revision 或请求身份，
  防止晚到的旧响应复活旧会话或覆盖当前状态。同步游标在全部异步读完成后与快照一起提交。

## 保留行为与有限清理

保留 A/B/C 的流式编辑、移动 Enter 换行、IME 保护、独立重问、活动手动偏好、回复公告和回底。
发送端仍再次核验准入；未确认终态只读取原 requestId 回执，不自动重发 AI 请求。
附件和消息图片仅在内存；新建/恢复失败、删除其他历史以及重开当前历史不清当前图片，
成功会话边界、设置重载、当前会话删除和离页统一释放。

清理范围为父页确定未使用/重复的 `activitiesDone`、`updateProposal`、`updateDraft`、
`providerDetailText`；消息组件继续承担活动状态和供应商错误详情展示。
旧金融候选与本地草稿兼容动作迁入 artifacts，保留 ready 守卫、requestId、
uncertain 状态读取和取消保护；本次没有新增这些旧动作的 UI 入口。

## 验证记录

| 验证 | 结果与证据范围 |
| --- | --- |
| 前一阶段完整 test:ai | 192/192；历史交付基线，不是本轮复测 |
| 旧 aiAgent 行为回归迁移 | 62/62；真实 controller 导入、显式服务注入与 dispose |
| 新增模块/协调层回归 | 新增 25 项；当前 aiAgent 75/75、实际 SFC UI 16/16、生命周期 7/7 |
| 最终 npm run test:ai | 217 tests / 217 pass / 0 fail，退出码 0 |
| 本轮 SFC/浏览器检查 | 父页与三个展示组件 script/template/style 编译通过；浏览器刷新恢复、窄屏 Enter、历史搜索与闲置回底通过，无新增 console 警告/错误 |
| npm run build | 本轮约定不运行 |
| 性能 | 未测量，不声明性能提升 |

测试入口已从抽取 Assistant.vue 脚本、删除 import 后执行 Function，改为直接导入生产 controller。
已有停止、回执、授权、会话、附件和业务产物断言保留；
新增测试继续验证真实模块与协调层组合，而非只验证复制出来的 helper。

## 尚需人工或后端验收

- NVDA 实际发声：流式期间静音，结束仅一次状态反馈。
- 物理手机软键盘、中文候选确认与焦点体验。
- C4 最后一句历史摘要依赖后端列表接口字段扩展，继续作为独立任务。

模块接口和维护规则见 [assistant/README.md](../../web/src/views/AI/assistant/README.md)。

本轮同时收口两个异步边界：手动回执与本地草稿结果晚到时核对当前会话和消息身份；
设置重载与远端删除通过 invalidateRequests 失效旧请求。请求忙状态与聚焦由所属 run 释放，
旧文字/OCR transport 即使忽略 abort 并迟到返回，也不会清掉新请求状态。

浏览器仅读取已登录历史和临时编辑草稿，未发送真实 AI/OCR 请求或写入业务数据；
验收后恢复空草稿并清除临时 viewport override。截图保存在
`temp/ai-chat-modularization-20261111/assistant-after.png`。

---

## 来源：CHANGELOG_2026-11-11_AI_CHAT_LOGIC_REVIEW.md

# 聊天页剩余逻辑结构评估（2026-11-11）

负责人询问 1112 行是否仍需优化。已核对剩余函数、展示组件和测试入口：
父页约 1029 行是脚本，下一阶段应拆职责明确的 composables。

建议先模型设置、图片/活动/视口，再会话、授权/同步，最后统一整理请求运行流程。
messages、conversationId 和 busy 仍保持单一所有者；取消、回执与重试共享请求身份和生命周期。
现有 aiAgent 测试依赖脚本抽取，模块迁移时必须一起改造测试入口。

本轮仅结构评估和文档更新，未改源码、未运行测试；上一轮 192/192 为已记录的交付结果，
本轮不将其表述为再次复测。详见 [下一阶段计划](PLAN_AI_CHAT_LOGIC_MODULARIZATION.md)。

---

## 来源：CHANGELOG_2026-11-11_AI_CHAT_UX_PLAN.md

# 变更日记 — 聊天界面体验打磨计划编制（2026-11-11，追加171）

## 范围

仅文档，**未动任何源码**：新建 `logs/PLAN_AI_CHAT_UX_POLISH.md`（执行计划）＋本编制记录＋
`api/README.md` 顶部引用一条。后端、前端、测试、构建产物零改动。

## 输入

2026-11-11 会话内对 `web/src/views/AI/Assistant.vue` 全量通读（模板 :1-198、脚本 :205-1282、
样式 :1284-1504）后的行业对齐评审（参照 ChatGPT / Claude Web / zCode），产出 8 项优化
（P1×2 / P2×3 / P3×3），归纳为 A/B/C 三批。评审时 `test:ai` 基线实测 159/161
（2 失败＝aiApiFixture 未适配后端 settings 新契约的外部已知问题）。

## 计划要点

- **批 A（P1）**：A1 图片预览保留到会话边界（`releaseImages` 从轮次 finally 移到会话切换点，
  记账凭证核对刚需）；A2 流式期间输入框解锁（并发安全由 `send()` 的 `allowed` 守卫兜底）。
- **批 B（P2）**：B1 中段回答「以此重问」（追加式重试语义，新 entry 路径 `reaskTurn`，
  原答保留原地、新 requestId 落档）；B2 移动端（≤600px）软键盘 Enter=换行。
- **批 C（P3）**：C1 读屏流式 `aria-live` 动态静音；C2 活动流完成不覆盖用户手动展开；
  C3 回底按钮离开底部常驻；C4 历史列表「最后一句摘要」依赖后端列表接口扩展字段，单列另立
  计划，本轮零后端改动。

## 约束与验证

- 约束：仅动 Assistant.vue；不碰后端与契约；图片「不落盘」口径不变；不覆盖并行会话在途改动；
  前端验证按负责人惯例只跑 `npm run test:ai`（159/161 基线），不跑 `npm run build`。
- 本轮未运行任何测试（仅编制计划，零源码改动）。

## 影响面

无。计划执行后预计改动面：`Assistant.vue` 模板约 3 处＋脚本约 5 处＋样式 0-1 处；
如需断言补强另动 `web/tests/aiAgent.test.mjs`。

---

## 来源：CHANGELOG_2026-11-11_AI_CHAT_UX_POLISH.md

# 聊天界面体验打磨与组件拆分（2026-11-11）

> A1/A2、B1/B2、C1-C3 已实现，三个页面专属展示组件已接线。
> `npm run test:ai`：**192/192 全通过，0 失败**；浏览器布局、窄屏换行、历史搜索和闲置回底已检查。
> C4 历史摘要仍属于独立后端任务；NVDA 发声及物理手机软键盘保留为人工终验。

## 授权与范围

负责人本轮明确要求“嗯，执行”，并提出将大体积聊天页拆为独立文件夹中的组件。
因此在原 Assistant.vue/断言范围上增加 `web/src/views/AI/assistant/components/`、组件说明、
实际组件挂载测试及 test:ai 脚本接线。未修改后端、契约、aiApiFixture、依赖或其他业务视图。
原计划见 [PLAN_AI_CHAT_UX_POLISH.md](PLAN_AI_CHAT_UX_POLISH.md)，实施补充见
[执行前核实](CHANGELOG_2026-11-11_AI_CHAT_UX_PREFLIGHT.md)。

## 功能变化

- **A1 图片预览**：移除 OCR 请求 finally 的全会话图片释放。成功/失败后均保留当前会话预览；
  新建成功、历史切换成功、设置重载、当前会话本机/远端删除和离页时释放并关闭预览器。
  创建/恢复失败、删除其他历史、重开当前历史不清理当前图片。
  会话切换时同步重置“本会话不再询问”，待发送附件与图片同意不跨会话遗留。
- **A2 输入自由度**：AI 回复期间 textarea 可编辑，发送仍经父级 allowed/busy 守卫。
  草稿在本轮完成后保留，停止行为未改。发送状态改为严格布尔值，消除子组件 props 类型警告。
- **B1 以此重问**：中段完成的纯文字回答新增入口；以原话和当前模式/会话新建 requestId 与消息对，
  原回答/requestId 不改，当前输入与附件不消费，重复点击不并发。
  恢复成功历史时按 requestId 配对原话；无法配对、图片/OCR、授权中或未完成的轮次不可重问。
  排除业务产物对象、残留身份、operationOutcome 产物及同轮拆出的续卡。
  末条重新生成保留现有路径，独立于中段重问。
- **B2 键盘**：≤600px Enter 默认换行；桌面 Enter 发送；Shift 与 IME 组合状态不发送。
- **C1 读屏**：本机流式/OCR 请求及远端 pending 时聊天 log 的 aria-live 为 off，空闲恢复 polite。
  外层独立一次性状态公告提供结束反馈；新建会话不会误播“回复结束”。
- **C2 处理流**：活动展开通过父级事件标记用户已操作；重复封口只停计时，不覆盖手动选择。
  重试/重新生成开始新运行时重置选择。
- **C3 回底**：离开底部即显示，idle 为向下图标、pending 保留三点；通用标签“回到最新消息”。
  回底与会话边界清理位置状态，闲置长历史也可使用。

## 拆分结果

按文件全部行数（含空行，忽略尾部空行）统计：

| 文件 | 行数 | 责任 |
| --- | ---: | --- |
| Assistant.vue 改前快照 | 1516 | 展示、样式与会话/请求逻辑混合 |
| Assistant.vue 当前 | 1112 | 页头、布局与会话/请求协调 |
| assistant/components/AssistantMessage.vue | 315 | 消息展示、格式化及消息样式 |
| assistant/components/AssistantComposer.vue | 185 | 输入、附件、模型选择及输入区样式 |
| assistant/components/AssistantHistory.vue | 127 | 历史抽屉、搜索分组及历史样式 |

父文件减少 404 行（约 27%），没有把同一状态机拆成多个相互写入的组件。
展示组件通过 props/events 交互，不直接发请求；消息详情/论据展开改为组件本地状态。
目录说明：[assistant/README.md](../../web/src/views/AI/assistant/README.md)。
核实期间另一会话改动了同页的 operationOutcome 前缀与状态卡 tc-grid；按最新模板迁移并保留，
没有用旧快照覆盖这些改动。快照仅用于本轮差异核对。

## 验证证据

本轮开始时复测基线已为 166/166（前次核实为 161/161，期间另有五项并行回归测试）。
本轮新增 15 项页面行为测试、11 项真实组件挂载测试，并加入 test:ai：

- `npm run test:ai`：退出码 0，tests/pass 192，fail/cancelled/skipped/todo 0。
- `node --test tests/aiAgent.test.mjs`：新增图片边界、重问安全、历史恢复、活动偏好、回底/公告及布尔发送状态验证。
- `tests/aiAssistantUi.test.mjs`：实际 SFC 编译并用 Vue/jsdom 挂载；11 项覆盖输入/IME、键盘、附件、回底、
  重问/重生成事件、活动展开、Markdown 清洗/明细折叠、图表数据匹配、授权/回执及历史操作。
  仅浮层壳、图表/数据卡内部和剪贴板效果作 stub，不以 jsdom 证明布局或读屏发声。
- Assistant 与三个子组件的 script/template/scoped-style 编译均通过。
- 浏览器实际打开聊天页：成功历史的中段入口显示“以此重问”，末条为“重新生成”；
  窄屏 Enter 后 textarea 实际保留换行，未发送；已恢复原草稿。
  桌面/窄屏布局、标题搜索空结果、移动底部历史抽屉、idle 回底显示/点击检查通过。
  临时视口覆盖检查后已恢复默认；修复 canSend 警告后重新加载并输入，新增 warn/error 为 0。
- `git diff --check`：通过。未运行 npm run build，未为验收再次调用真实 AI/OCR 或修改业务数据。

## 仍需人工终验

- NVDA/浏览器真实发声：流式期间静音、结束仅一次状态反馈。
- 物理手机软键盘、中文候选确认与焦点体验；浏览器窄屏和组件事件测试已完成。
- C4 列表摘要按独立后端任务补契约后再接展示，不阻塞本次交付。

---

## 来源：CHANGELOG_2026-11-11_AI_CHAT_UX_PREFLIGHT.md

# 聊天界面体验打磨执行前核实（2026-11-11）

> 后续实施已完成，最终结果见 [功能与组件拆分执行日记](CHANGELOG_2026-11-11_AI_CHAT_UX_POLISH.md)。本文保留执行前的核实快照。

> 结论：原计划可以推进，但须按本文补齐图片释放边界和中段重问保护。
> 当前阶段：执行前核实完成，A/B/C 功能仍待实施；本轮未修改前端源码。
> 原计划：[聊天界面体验打磨执行计划（批 A/B/C）](PLAN_AI_CHAT_UX_POLISH.md)。

## 输入与范围

用户要求找到这份 UX logs 并检查如何执行。已定位原计划、编制日记及 README 引用，
对照当前 Assistant.vue、历史恢复、跨端同步、图片处理、本地 journal 和 aiAgent 测试检查可执行性。
按根目录 agent.md 的约定写本记录并同步 api/README.md 引用。

后续源码范围仍为 `web/src/views/AI/Assistant.vue` 和必要的 `web/tests/aiAgent.test.mjs`；
不引入依赖，不扩展后端契约，C4 历史摘要另立后端任务。
当前 web 存在大量未提交改动，Assistant.vue 在核实期间也有并行变化；实施时重新读取相关函数，
按函数名定位并做局部修改，原计划行号和总行数仅为编制时快照。

## 当前验证基线

在 `D:\Code\live\web` 执行 `npm run test:ai`，退出码 0：

- tests：161；pass：161；fail：0；cancelled/skipped/todo：0。
- 原计划的 159/161、允许 2 项已知失败口径已经过期；后续不得再以该口径放行回归。
- 每批验收应保持全部测试通过；新增测试后总数可增加，失败数仍必须为 0。
- 本轮未运行 `npm run build`，未做浏览器或真机体验验收。

## 建议执行顺序

### 1. 批 A：先完成图片生命周期和输入解锁

**A1：移除图片请求 finally 的全会话 `releaseImages()`，保留当前会话内预览。**

原计划称 `settingsChanged` 已有释放调用，当前代码并非如此；删除当前会话也缺少释放。
需在替换/清空旧 `messages` 之前释放，关闭仍打开的图片预览器：

| 会话边界 | 当前实现与应补动作 |
| --- | --- |
| `newConversation` | 已有释放；创建新会话成功后再清理，创建失败保留原会话 |
| `settingsChanged` | 补释放，放在 `messages = []` 之前 |
| `resumeConversation` | 新历史读取及恢复成功后、替换旧消息之前释放；失败保留原图片 |
| `removeConversation` | 仅成功删除当前会话时释放；删除其他历史不清当前图片 |
| `onRemoteConversationDeleted` | 当前会话被远端删除时已有释放 |
| `onBeforeUnmount` | 已有释放 |

`clearImage()` 只清附件，不等于释放消息里的预览。journal 继续仅传原话、requestId 和状态，
不写入 dataUrl；刷新、离页或切换会话后图片不承诺恢复。
现有跨端合并保留本机消息的预览，应加入一次同步回声验证，避免清理时机被其他路径破坏。

**A2：textarea 只按能力开关禁用，发送动作继续受 `allowed/busy` 守卫保护。**

回复期间可继续打字；桌面 Shift+Enter 换行。桌面 Enter 在 busy 时不触发第二个请求，
停止按钮行为保留，流式完成不能清空下一条草稿。

批 A 完成后补行为断言并运行 `npm run test:ai`。重点验证 OCR 成功/失败后图仍可查看、
所有会话边界清理和失败切换保留、草稿保存，以及回复中 Enter/发送点击不并发。

### 2. 批 B：独立实现重问，再补移动端键盘

**B1：中段「以此重问」新建消息对，不复用 `send()` 或 `retryTurn()`。**

`send(example)` 仍会清空当前草稿和附件；`retryTurn(entry)` 会重置原消息并替换 requestId。
新入口应保留编辑器内容与附件，以原话创建新 requestId、新 user/assistant 消息对，
先 `journalTurn`，再走 `prepareTurn → confirmTurn`，使用当前会话与当前模式。
这是带当前会话上下文的新提问，不回退至历史位置。末条「重新生成」维持现有行为，另测互不影响。

准入条件在 UI 与 handler 两端落实：

- 原 entry 仍在当前消息列表，能力启用、业务版本匹配、无 busy/重复点击。
- 使用完成态白名单：中段重问只接受可靠原话的 `completed` 文字轮次；
  `uncertain`、远端 pending/remote 进行中、授权等待或拒绝均不接受。
- 排除 `draft/proposal/inputCandidate/businessArtifactId`，以及卡片读取失败仍保留的
  `draftId/proposalId/candidateId`；`operationOutcome.artifacts` 非空也视为有业务产物。
  同 requestId 拆出的续卡一并检查，不能只看有文字的主气泡。
- 排除 OCR/图片轮次；本地无文字 turn 不代表恢复后也无 turn，不能把“识别这张图片”当作完整原话重发。
- 在 Assistant.vue 的 `restoreBusinessHistory` 包装函数中，按 requestId 配对用户原话，
  为成功文字历史补 completed turn；不能依赖后续增量同步碰巧补齐。
  找不到原话时隐藏入口，不猜测相邻用户消息。

B1 行为测试至少覆盖：原 answer/entry/requestId 不变；尾部只追加一对且新 requestId；
连续双击只有一次请求；草稿与附件保留；业务身份/续卡/OCR/uncertain/pending 不可重问；
恢复成功历史可以重问，无法配对原话则隐藏。现有 pageHarness 可扩展，无需增加测试依赖。

**B2：复用现有 `isNarrow`，≤600px 时 Enter 保留默认换行。**

桌面 Enter 发送、Shift+Enter 换行、IME `isComposing/keyCode 229` 保护保持。
验证 600px/601px 边界与中文输入法；手机发送按钮仍是明确提交动作。

### 3. 批 C：随批 B 收口，但保留独立验收

**C1：流式静音需覆盖本机请求与远端 pending。**

保留 `role="log"`，活动期间 `aria-live="off"`、空闲 `polite`。
不能仅看本机 `streamingActive`；也不宜用包含设置/卡片操作的全局 busy 替代聊天活动判断。
`off → polite` 不保证读屏主动播报已完成答复，需用 NVDA/浏览器验证；
若无完成反馈，在本文件增加一次性“回复已完成”的独立状态提示。

**C2：手动展开标志应跨重复封口保留，新运行重置。**

当前展开按钮只在 `activitiesDone` 时出现，“处理中手动展开被完成强制收起”不是正常单轮路径。
该项实际防止后续重复封口覆盖用户选择；新增 touched 标志不必扩展处理中展开交互。
`sealActivities` 继续停表，只有未手动操作时自动收起；retry/regenerate 开始新运行重置标志。
测手动展开后重复封口不收起，以及新运行恢复默认。

**C3：离开底部即显示回底按钮，pending/idle 分开显示。**

pending 保留三点动画；idle 用向下图标或文字。统一标签“回到最新消息”。
显隐由 `scrolledAway` 控制，`bottom()` 与会话替换后同步更新它，避免闲置时仍提示 AI 正在回复。
验证长历史无请求时可回底、回复时可回底、切换会话不会残留按钮状态。

### 4. C4：独立后端工作

历史摘要仍依赖列表接口增加 `lastMessage/lastMessageAt`，不阻塞上述 7 项。
另立任务时明确摘要截断与隐私、空值回退、排序/时间语义，再接前端 meta 行。

## 续接清单

- [x] 定位原计划及编制记录
- [x] 对照当前实现检查可执行性
- [x] 复测当前 test:ai 基线：161/161
- [x] 写执行前补充记录并同步 README 引用
- [ ] 批 A 局部实现、行为断言、全绿测试与图片/输入验收
- [ ] 批 B 局部实现、重问保护与键盘验收
- [ ] C1-C3 实现、行为断言、全绿测试与实际读屏/移动端验收
- [ ] 写功能执行日记，更新原计划勾选状态和 README

本记录中的测试结果仅证明当前基线；A/B/C 验收尚未完成。原计划的实施清单本轮不勾选。

---

## 来源：CHANGELOG_2026-11-11_AI_CHAT_VALIDATION_ROUTING.md

# AI 对话按实际工具与成果选择答复校验（2026-11-11）

用户要求场景选择与提示词一起交给 AI，判断是否涉及数据查询，再触发业务校验；同时要求普通闲聊能写散文和 Markdown，并复制原始 Markdown。

本轮在原核心收口之后继续修改，旧 `CHANGELOG_2026-11-11_AI_CORE_CLOSEOUT.md` 的版本与验证仅作为历史，不代表此次新增代码已验证。

## 实现

- 场景 `mode`、本轮原话 `userTurns`、能力目录继续同包进入 `TASK_INPUT`，增加明确的工具选择与答复策略说明。复用原模型原生工具选择，不增加分类模型调用。
- `responseValidation.js` 根据服务器实际 dispatch 尝试、数据集、成果和记忆证据锁存范围。工具参数失败、权限拒绝和未知工具不能让后续答复降级；正文里的 `requires_data` 或 `claimsScope` 等自报字段没有控制权。
- 无业务活动的 `chat/analysis` 使用 prose 声明范围；普通文本净化保留链接、邮箱、长数字、普通 UUID、代码、缩进和换行，同时继续隐藏配置凭据、真实本人/会话等已知内部 ID 和不可解析的旧引用。
- 实际查询/候选读取或业务成果沿用严格业务校验。记忆、历史工具启用对应证据及私有文本净化；仅获授权不等于已经读取数据。
- prose 仍校验明确的应用效果：入账、写入账簿、余额修改、业务对象删除等需要真实回执；显式长期记忆保存仍核对真实保存证据。文学“记住夏天”“修改文章”及明确的支付代价修辞不会被当成系统操作。
- 正文结果、存档、恢复回执共用同一个组装值；完整思考仅在结果事务成功后按最终范围重新净化和核验。工具轮的中间正文、思考、参数在重传供应商前重新净化，保留当前批准的引用及工具调用配对编号。
- 普通文章的正文上限仍为 12000 个 JavaScript 字符（UTF-16 code unit）；超限明确返回 `AI_ANSWER_TOO_LONG`，不保存截断的成功文章。模型 token、工具调用、每日额度及数据外发预算没有取消。私有文本沿用旧展示预算，但完整凭据和 ID 先净化再切限，防止边界残片泄漏。
- Web 复制继续传 `item.text`，即 Markdown 源文。逐笔明细折叠依据实际 `marked.lexer` 排除围栏和缩进代码，不再拆坏四行日期代码样例；渲染仍经 DOMPurify。
- 完整回归同时发现设置保存的内存/数据库时间戳相差一次 `now()`；持久化统一使用 `record.updatedAt`，保留原完整 profile 原子回滚检查，并新增递增时钟回归。

## 主要文件

- `src/modules/ai/service/responseValidation.js`、`v3Service.js`、`v3ResultAssembly.js`、`verifiedReasoning.js`。
- `src/modules/ai/service/egressPolicy.js`、`v3Claims.js`、`memoryClaims.js`、`openConversation.js`、`requestGuard.js`、`settings.js`。
- `../web/src/utils/aiMarkdown.js`、`../web/src/views/AI/assistant/components/AssistantMessage.vue`；消息组件只改 Markdown 分段逻辑，保留并行会话其他 UX 改动。
- 对应 API unit 测试，以及 `../temp/ai-chat-validation-routing-20261111/` 的生产 SFC Markdown 渲染与复制定向验证。

## 验证与边界

最终冻结验证于 2026-11-11 15:46:37–15:47:42（Asia/Shanghai）完成：API **212 套 / 4770 项**、Web **19 个 AI 测试文件 / 280 项**全部通过，失败/取消/跳过均为 0；前端生产构建 exit 0。本次使用原审计 209 套清单并合并当前 AI 测试，包含并行会话新增的 retry 回归与本轮新增 responseValidation 回归，不沿用旧收口计数。

`source-final-before.json` 与 `source-final-after.json` 的 **695 份源码/测试/构建配置 SHA-256 完全一致**，覆盖 API 编排与声明守卫、Web Markdown helper、实际消息组件和并行会话模块化后的文件。最终日志：`api-final.json/log`、`web-final.log`、`web-build-final.log`，汇总为 `verification-final.json`。

- 定向回归覆盖场景/原话到供应商、无工具文章原文、结果/历史/回执一致、12000 边界、拒绝/失败/未知工具、模型自报路由无效、跨片凭据及最终思考范围。
- Web 生产 SFC 编译、真实 `marked` 与 DOMPurify、真实复制方法：20 项通过；围栏/缩进代码与普通正文折叠均覆盖。Clipboard API 与备用 textarea 仅替换平台边界，证明传入源文一致，未冒称实际 OS 剪贴板或登录浏览器验收。
- 运行范围为离线 scripted provider 与数据库 fixture，没有本轮付费模型调用、正式业务库写入或 `api/data/memory` 写入；没有修改 `.env`、模型配置或额度。
- 声明校验仍是有界词面规则，不宣称能证明任意自然语言真假。核心阶段继续是发布候选验收；本次模拟链路验证不替代真实供应商对任意文章的质量和工具选择表现。

证据目录：[当前版本验证](../../temp/ai-chat-validation-routing-20261111/verification-final.json)、[Markdown 验证说明](../../temp/ai-chat-validation-routing-20261111/MARKDOWN_COPY_VERIFICATION.md)。

---

## 来源：CHANGELOG_2026-11-11_AI_CORE_CLOSEOUT.md

# AI 核心架构收口与 qwen 对话中断修复（2026-11-11）

承接 [核心架构复审](REVIEW_2026-11-11_AI_CORE_ARCHITECTURE.md)。本轮完成核心边界修复和指定故障调查，保留原审计及失败记录；不提交 Git，不变更用户额度、模型、`.env`，不自动重发失败的模型请求。

## 1. 指定故障与归因范围

目标为 `e5aeb868-1d3c-47d8-8192-7f2f91911ff0`，2026-11-11 12:57:14（Asia/Shanghai），`qwen3.8-flash`，供应商第三轮 45026ms 后 `AI_PROVIDER_FAILED`。

- 第一、二轮供应商调用分别 5819ms、6357ms 成功，5 次 `query_data` 成功；第三轮实际底层 cause 是 `ERR_BAD_RESPONSE`。
- 失败时心跳租约仍有效，deadline 晚于失败约 32.6 秒；供应商超时配置为 105000ms，总轮配置为 300000ms。附近另一次同 cause 失败耗时 64826ms。因此没有证据支持固定 45 秒租约/网关超时的归因。本地映射的 HTTP 502 也不代表上游 HTTP 502。
- 当前 qwen/maas 能力识别为 unknown，实际 `max_tokens=4096`。旧实现将正文预算 262144bytes 同时用于 SSE 原始线缆字节，逐片 JSON 信封开销可以提前耗尽该预算。
- 用真实安装的 Axios 1.16.1 HTTP adapter 与纯内存 transport 复现：正文 1800 个中文字符、5400bytes，SSE 共 374481bytes；旧 262144bytes 上限抛出同形 `ERR_BAD_RESPONSE / maxContentLength ... exceeded`。当前生产客户端允许这段正常流，同时拒绝正文或线缆超限，并映射为 `AI_PROVIDER_RESPONSE_LIMIT`。
- **历史请求没有保存原始错误 message 或线缆字节，不能断言该条历史失败必然由超限引起。** 这是已确认、与现场高度吻合且已修复的真实缺陷。未重放旧编号或用户原对话。

调查证据：`../../temp/qwen-request-audit-20261111/INVESTIGATION.md`、`request-audit.json`、`axios-wire-limit-replay.json`；当前代码复验为 `axios-production-stream-final.cjs/json/log`。

### 原 A3 结论订正

原复审 A3 写成“流式没有落实原字节上限”，依据的替身 transport 没有执行 Axios adapter 限制；该证据不足以代表实际安装的 Axios 1.16.1。正确问题是**已有原始线缆限制错误复用了正文预算**，以及解析器需要补独立、可诊断的内容/帧边界。旧原文和失败证据作为历史保留，不改写为当前结果。

## 2. 实现收口

| 原审计项 | 本轮实现与保证 |
|---|---|
| A1 思考增量绕过校验 | `verifiedReasoning.js` 每轮完整缓冲最多 12000 字符、整请求最多 24000；超限整轮省略，整串净化防跨片凭据泄露。只有最终结果事务成功后核对成果声明并发送 `verified:true`。失败/取消不发布思考，合法正文不因省略思考而失败；状态与工具进度仍实时。Web 仅消费已核验全文快照。 |
| A2 损坏流误报成功 | `providerStream.js` 显式校验坏 JSON、上游 error、角色、终态、工具参数分片、usage-only、断流与取消；支持 UTF-8 跨片、BOM、LF/CR/CRLF、多行 data。收到 `[DONE]` 即结束，不等待 socket 关闭。网关在同一次 stream 请求中返回完整标准 JSON 时直接解析，不额外调用。 |
| A3 SSE 预算 | 解码预算保留 `max(256KiB,min(8MiB,max_tokens*32))`；线缆预算独立为 `min(64MiB,decoded_limit+max_tokens*512)`，另有单帧/帧数量上限。没有提高模型 token、工具、授权数据外发、每日调用预算。 |
| A4 可信操作状态 | `operationOutcome.js` 只从本轮真实 artifacts 构造 `none / needs_input / awaiting_confirmation`、实际 ID、kind、状态与核对资格；V3 聊天不执行正式业务，`formalWriteExecuted:false`。结果、聊天 business、恢复回执同源；Web 对账真实产物 ID，独立显示“生成时状态”，兼容旧历史。混合多卡的 singleton draft/candidate 身份也保留至历史恢复。 |
| A5 Web fixture | 设置 fixture 增加内存事务、未提交不可见、回滚、connectionId 轮换及 SQL 白名单；保留禁止真实 DB/供应商与收尾拒绝计数断言。 |

新增四类明确错误：`AI_PROVIDER_RESPONSE_LIMIT`、`AI_PROVIDER_INCOMPLETE`、`AI_PROVIDER_STREAM_INTERRUPTED`、`AI_PROVIDER_INVALID_RESPONSE`。即时错误与持久回执都有可读提示，HTTP 200 后的 transport cause 仍保留。供应商失败审计保存 round、finalRound、maxTokens、JSON/thinking 设置以及脱敏 diagnostics/cause/providerDetail。

`callLog.js` 将 64Ki 字符裸截改为 64KiB 字节边界。超限时保存可解析 JSON 摘要与净化 preview，保留轮次、角色计数、消息字节及工具名，避免第三轮载荷再次变成损坏 JSON。原记录未修改或迁移。

主要 API 文件：`deepseek.js`、`providerStream.js`、`providerDetail.js`、`v3Service.js`、`verifiedReasoning.js`、`callLog.js`、`requestGuard.js`、`operationOutcome.js`、`v3Claims.js`、`v3ResultAssembly.js`、`openConversation.js`。主要 Web 文件：`aiBusinessContract.js`、`aiBusinessHistory.js`、`Assistant.vue`、`aiApiFixture.mjs` 与相应测试。其他会话的聊天 UX 改动保留；消息模板随后由该会话移至 `assistant/components/AssistantMessage.vue`，最终验证须包含此组件。

### A4 的有限保证

审计具体绕过“这笔款项已经写进账簿，余额也变了。”在完整 chat/analysis 链路中已被拒绝，用户既有事实、历史、否定、条件句保留。但有限词面规则不证明任意中文/英文自然语言真实性。模型正文用于解释；权威操作状态来自服务器产物和真实执行回执，不能宣称所有模型虚假声明已消除。

## 3. 当前版本真实 qwen 连续对话

只使用新公开记账说明与公开追问，同一个新 manual 会话 `a7c5e0af-bbe2-499b-8e08-3ab64a42376f`；走当前生产 `createAiService/V3` 模块和该用户实际 requestGuard/日预算，不绕并发或调用护栏。

| 请求 | 结果 | 用时 | 原始线缆 | 模型调用 |
|---|---|---:|---:|---:|
| `6b2e1437-7921-4caf-94f7-a5b6ec550081` | 1935 字完整回答，5703 正文字节 | 33435ms | 148024bytes | 1 |
| `2125c44e-07ee-4d86-9912-56ac49054025` | 同会话追问，382 字、五条归纳 | 9059ms | 34196bytes | 1 |

- 两次各回读回执两遍，均 `completed`、`providerCalls=1`、结果一致；历史恢复为 user/assistant/user/assistant 四条，回读和历史读取新增调用为 0。
- 第二轮实际请求含两条 userTurns 与第一轮 priorAnswer；已有上下文预算将第一轮解释截为 1200 字符，验证了真实承接。
- 实际 host/model 为 `maas.qianwenaiapi.com / qwen3.8-flash`；预检 running=0、额度充足；日计数 15→17，总实际付费调用 **2 次**，reported tokens 19256。无第三次测试、失败重试或旧编号重放。
- executor 强制仅 AI 表 SQL 白名单；两轮 forbiddenSql=0，写入仅为正常 AI 会话、请求/租约、活动和审计。没有正式业务 SQL 或记忆写入；memory 前后 hash 相同，关键 API 源码 before/after hash 相同。
- 两次真实流量都没有跨旧 256KiB 阈值，因此证明当前正常连续对话成功，不能直接补证历史第三轮超限。跨旧阈值形状由真实 Axios + 当前生产客户端的内存回放单独证明。

证据：`../../temp/qwen-request-audit-20261111/real-qwen-public.json/log`、`real-qwen-followup.json/log`。真实验证直接使用当前生产服务模块，非浏览器登录链路；不能冒充当前 7788 进程内模块 hash 或完整浏览器验收。

## 4. 最终验证与版本范围

- API 首次收口全量：209 套 / 4521 项，0 失败，13:18:36–13:19:38；原证据 `api-closeout-final.json/log` 保留。最终文件核对发现 `requestGuard.js` 时间戳更新至 13:23:06，故重新绑定当前版本：**209 套 / 4521 项，0 失败**，13:32:14–13:36:01（Asia/Shanghai）。`npm run test:ai` 覆盖 186 套 / 4168 项；补跑原审计清单剩余 23 套 / 353 项，两组不重叠。证据为 `../../temp/ai-core-audit-20261111/api-closeout-frozen.json/log`、`api-closeout-frozen-complement.json/log` 及合并清单 `api-closeout-frozen-all.json`。运行期间采集的 450 份 API 源码/测试 hash 随后全部一致，相关文件 mtime 均未晚于最终运行开始。
- Web 最新版本：**18 个 AI 测试文件 / 242 项，0 失败、取消、跳过**；最终 `npm run build` exit 0，13:39:52–13:40:00。231 份源码、测试、配置 hash 在回归和最终构建之间完全一致，包含三个拆出的 Assistant 组件；最终总清单再次核对仍一致。证据 `../../temp/ai-core-closeout-20261111-web-final/verified-closeout.json`、`web-ai-tests-final.log`、`web-build-final.log` 与四份 final manifest。之前 216 通过、后续 241 项中 1 项旧路径失败及构建文件变更的中间证据均保留，不冒充最新验收。本轮将 `aiQueryScope.test.mjs` 的源路径改为实际 `AssistantMessage.vue`，原跨月份断言全部保留。既有大 chunk / Browserslist 提示未引入新的依赖改动。
- 临时真实 MySQL：原 Stage1 两套的 **7/7** 通过，包括设置轮换、日额度争抢/跨进程、候选独立读取、虚假入账拒绝与合法否定。S5 与跨进程控制使用真正 SSE；另有完整 JSON fallback 对照。
- 追加四组有界恢复验证通过：SSE 授权门控及失败同号回读；授权后的 SSE 工具参数分片和两轮往返；成功同号回读零新增调用且绑定本人；全新进程恢复回执、四条历史、授权及 completed activity。使用当前生产模块、真实 SQL、循环地址脚本 provider，**供应商付费调用为 0**。
- 真库验收使用派生 harness、全新独立 schema 及只获当轮 schema 权限的临时 writer/reader；正式业务/记忆与共享 `live_ai_test` 不受影响。265 份 API 源码、原测试、DDL/迁移 hash 全部不变，副本完整 diff 保留。第一轮 7 项证据在 `../../temp/ai-core-audit-20261111/isolated-real/saved-run-e4bcbd17/`；最终 4 组恢复及自然退出/清理证明为该目录的 `final-handoff.json`、`isolation-report.json`、`bounded-recovery.json`。不重复计算两轮重叠的恢复检查。
- 两次真实 qwen 验证逐次核对的是五份关键供应商/编排源码，不是整个工作区的不可变快照；请求护栏更新由上述最终离线与真库复核覆盖。现有 7788 的 nodemon 进程随后启动时间晚于当前 API 修改，但未提供进程内不可变模块 hash，不能把文件 mtime 当成该保证。

### 临时验收生命周期修正

首次派生 harness 创建了 V3 agent 却只返回/关闭 legacy service，遗漏 agent 自有只读池的 `close()`，导致验证结果已通过后进程仍存活。已确认这属于临时夹具的 teardown 遗漏；原轮只精确清理本次 schema/reader 的剩余连接并保留记录，随后修正夹具返回值和资源释放顺序，仅重跑四组恢复检查。第二轮 schema `live_ai_core_20261111_e0dc37f4` 自然退出 exit 0，无手动 KILL；两份 runtime-closed 均 pendingResponses=0。最终只读核对证明两个 schema、临时账号、连接都不存在，剩余测试进程为 0。

生产 V3 已有自有仓库 `close()`；生产信号路径在标记/abort 后 `process.exit`，由 OS 释放连接。不能将夹具遗漏解释成每轮连接泄漏或此次 45026ms 对话失败。独立完整 `closeAI`/drain 生命周期可作为后续维护改进；现有 `shutdownAll` 不等待后台 work 完全结束，不能直接提前关闭共享写池。

### 统一冻结清单

`../../temp/ai-core-audit-20261111/source-manifest-final.json` 记录 661 份 API/Web JS/Vue/MJS 生产源码、实际运行的测试与 package 文件；摘要为 `closeout-summary.json`。最终 sourceDigest：`1d0f43b7cfa26fcbda026fa03c216bdc837aa6a5af12ac908ae9630bf018a0ae`。清单明确排除 `.env`、凭据与 memory，不是不可变隔离工作副本。

该摘要逐一验证当前 API 源码/测试与运行期间采样 hash 一致、当前 Web 与最终构建的 231 份 hash 一致、两次真实 qwen 的关键模块一致、真实调用共 2 次、回读增量为 0、正式业务/记忆未写，以及独立真库自然退出和完全清理。旧审计、回放、首次回归、中间失败及旧真库运行均保留各自版本身份。

## 5. 阶段与后续

核心架构已基本定型，本轮修复完成后进入**当前流式版本的发布候选验收阶段**。没有发现需要推翻工具读取、人工执行、授权、事务/恢复主架构的证据，也无需以文件行数为目标继续大拆。

发布最终版仍应绑定同一版本证明必要的真实工具往返、授权续流、异常/取消、同号回读、历史恢复及业务执行场景。当前两轮公开真实 qwen 证明正常连续聊天，不能代替原分析对话的第三轮工具场景或全业务矩阵；旧 v2 九场景、Q123 与 P/BG 的混合版本限制保持原记录。

真实登录浏览器/当前全部业务组合不是本轮证明范围。后续按受影响边界补验收，再推进 calc、黄金质量评测、供应商能力登记/故障切换等能力；不为文风或表面行数持续重构、重复付费。

---

## 来源：CHANGELOG_2026-11-11_AI_MOBILE_TRANSPORT_AUDIT.md

# 手机 AI 传输/重试审计记录（2026-11-11）

用户反馈手机流式请求长时间不答复，点击重试后出现旧问题的回答或旧失败内容；指定请求 `88141af7-61b5-4e4c-9a56-0b76313db122`。

已并行审计前端请求/重试/恢复、底层 SSE/同步/握手、后端终态/回执/历史，并对指定请求作只读 SELECT。确认主终态可被同步记录阻塞、旧回执覆盖完成正文、权威读取失败生成假失败、失败原话按邻近消息绑定等问题。另记录失败续接身份、长文存档截短和握手竞态。指定编号实际发的是文章概述，约 47.4 秒/5 轮正常 completed；Hello 为更早另一轮，不把代码反例当作本次触摸或网络抓包。

现有相关回归 API 196 项、Web 133 项通过；新增生产 controller 安全断言有 4 项失败，作为缺陷证据保留。运行代码未改，未新增付费模型调用，未写正式业务库或记忆；只添加审计文档和工作区 temp 证据。

当前传输/恢复仍需修复后验收，不能沿用此前核心收口来宣称该链已完成。完整问题、边界、建议和证据见[审计报告](REVIEW_2026-11-11_AI_MOBILE_TRANSPORT.md)。已同步 api/README.md 索引。

---

## 来源：CHANGELOG_2026-11-11_AI_MOBILE_TRANSPORT_FIX.md

# 手机 AI 传输、重试与恢复修复（2026-11-11）

> 后续业务核对卡缺失修复已单独收口：用户实测成功，最新 API 4833 项、Web 342 项及构建通过。此前传输验收未覆盖完整功能卡 UI，此次补齐真实业务组件回归。见 [业务卡恢复与最终验证](CHANGELOG_2026-11-11_AI_BUSINESS_CARD_RESTORE.md)。下文保留本轮传输修复当时的基线与证据。

用户明确要求“直接修”。本轮在既有未提交修改上增量修复，没有提交、重置工作区、修改模型或额度配置，没有新增付费调用、正式业务数据写入或正式 memory 写入。

## 修复行为

| 原问题 | 当前处理 |
| --- | --- |
| 准备同步活动卡住，SSE 头与心跳尚未开始 | 先发 queued 状态启动 SSE；会话准备与活动初始化共享整轮时限及中止信号。取消/超时后迟到的初始化不能再启动模型。 |
| 成功回执已确定，辅助同步仍阻塞 done | 主成功结果及历史事务保持原顺序，辅助活动更新不再阻塞 done。失败历史和活动并行，最多等待 1 秒；原写入继续执行，保留请求和重试关系。 |
| ai_request_run 查询异常被当作无记录，生成假超时 | 权威查询失败使本次快照失败，留给只读重连恢复，不推断伪造的 failed。 |
| 旧手动回执、自动轮询或旧快照擦除完成结果 | 按请求身份保留完成终态，完成后停止该请求的轮询；活动比较更新时间及同时间终态顺序。旧在途 GET 可补消息，但不能回退较新的活动、实体或重试关系。 |
| 持久结果已到，原 POST 流仍占用 sending 和发送锁 | 同请求的持久终态撤销旧运行所有权，取消旧等待再合入完整正文/卡片，立即允许下一问。不同请求及单独活动镜像不能解除当前运行；旧 catch、finally 和事件不能操作新请求。图片无 turn 和多卡占位均覆盖。 |
| 失败气泡误借邻近用户原话，重试发送另一问题 | 失败原话按 requestId 精确绑定；同步增量会纠正本地误绑，缺失或矛盾时不借其他问题。重试按钮显示“重试此问题”和原话摘要，缺原话保留只读恢复入口。 |
| 首次普通失败重试缺少持久父子身份 | 确认失败父轮后发送 retryOf，父历史未完成时不以无关新请求绕过认领。会话打开前就结束的已准入失败，通过内部 owner/lane/input_digest 和真实失败回执确认后补父历史，不把零调用数当未准入证明。已完成的正常重新生成保留原行为，并延后清除正文。 |
| 准备阶段明确未准入的失败无法重试 | 仅准备阶段生成 AI_PREPARATION_TIMEOUT / AI_PREPARATION_CANCELLED，且信封须同时满足 notAdmitted=true、providerCalls=0；与已准入的零调用失败分开恢复，刷新后的本地记录和远端活动仍保留这个含义。 |
| 7500 字长文返回完整，历史却截成 4000 字 | V3 存档共用答复 12000 字符上限，超限在任一消息写入前明确拒绝；列表、增量同步及模型历史读取同源正文。本地完整答复不会再被旧截短历史覆盖。旧 V1/V2 与思考存档预算保留。 |
| 密钥清理后旧握手覆盖新缓存 | AES、RSA 与握手锁按代次和 Promise 所有者隔离，旧请求不能写入新缓存或解除新锁。 |
| SSE 坏帧静默丢失，换行和分片不兼容 | 支持 LF、CRLF、CR 与跨片边界；坏 JSON 或超大未完成帧明确报协议错，限制缓冲；done/error 之后的尾部字节不再破坏终态。 |
| “第一篇”历史查找只能从最新匹配开始，缺少精确时间 | history_search 增加 oldest/latest、角色和完成/失败筛选，固定 SQL 片段且继续绑定本人本会话；search/read 保留准确 sourceTime。提示词说明最早匹配和歧义澄清。此能力不保证任意模糊指代都可自动消歧。 |

## 验证

最终版本完整回归完成于 2026-11-11 17:03（Asia/Shanghai）：

| 验证 | 当前版本结果 |
| --- | --- |
| API 既有审计清单加全部当前 AI 测试 | 214 套 / 4815 项通过，0 失败 |
| Web 全部 AI 测试 | 19 个文件 / 323 项通过，0 失败或跳过 |
| Web 生产构建 | 通过 |
| 源码与 fixture 指纹 | API 484 份、Web 239 份，在各自完整验证期间一致；最终 API 验证后 Web 再次比对也一致 |
| 离线反例 | API 传输 8/8、前端传输 14/14、controller 归属 8/8、独立挂起流恢复 5/5、独立失败父轮 10/10 |

当前结果：[完整验证摘要](../../temp/ai-mobile-transport-audit-20261111/verification-final.json)。完整日志、测试清单与前后 SHA-256 均在证据目录，可通过 verify-api-final.ps1 / verify-web-final.ps1 复跑。此前审计红基线及中途版本结果不代替此次最终版本验收。

- 新修复的 API 传输反例、前端传输反例及 controller 归属反例分别另存 backend-fixed.json、transport-fixed.json 和 assistant-ownership.production.fixed.result.json；原审计红证据保持可追溯。
- 独立复核覆盖旧流仍挂起时的完成/失败、图片、单卡/多卡恢复，以及不同请求不能解锁当前运行、旧事件和旧 finally 不能清新 busy。
- 长文测试直接调用真实 conversation store 的数据库替身，验证 7500/12000 字符存入与三种读取均完整，12001 字符不保存任一消息；未执行真实数据库写入。
- 历史检索永久测试覆盖最早已完成文章、SQL 注入拒绝、本会话归属，以及 legacy/chat 两种场景的完整 search→read 路径；使用 scripted provider，没有真实模型调用。

证据目录：[本轮离线证据](../../temp/ai-mobile-transport-audit-20261111/)。原审计：[手机传输审计](REVIEW_2026-11-11_AI_MOBILE_TRANSPORT.md)。

## 实测边界和阶段

本轮没有新增实体手机、真实弱网或后台切换实测。SSE 继续实时发送状态/工具进度，正文在验证和持久化完成后发送完整结果；模型多轮查询耗时不等同于传输丢失。

用户指定的 88141af7-61b5-4e4c-9a56-0b76313db122 仍按此前只读证据解释：服务器实际收到的是文章概述请求，回执和历史身份一致；Hello 属于更早请求。离线复现证明的缺陷已经修复，不能把反例冒充指定手机操作的完整因果。

当前代码修复与离线验收已收口，进入实体手机终验阶段。手机端刷新加载当前代码后，应核验连续两问、失败重试原话、断网/后台恢复和长 Markdown 复制；无需为本次传输缺陷继续扩大架构重构。

---

## 来源：CHANGELOG_2026-11-11_AI_TEMP_AND_IGNORE.md

# 遗留归档移入 temp 与 ignore 收口（2026-11-11）

> **撤回状态**：用户随后要求恢复 ignore 变更。本次新增的根 .gitignore 已删除，其余 7 份原规则按备份逐字节恢复；110 项 Git 跟踪已恢复，5 个仓库无本次留下的暂存变更。所有本地文件保持不变，temp 归档和此前代码清理保留。下文保留原操作记录；当前 ignore 状态以本撤回说明为准。验证记录：temp/ai-ignore-20261111/ignore-rollback.json。

按用户要求，将本次清理归档从 api/archives/ai-v1-v2 移到 [temp 归档](../../temp/ai-v1-v2-cleanup-20261111/archive/README.md)。33 个文件移动时原字节一致，28 个脚本文本 SHA-256 一致，before.zip 保留原指纹；原目录已移除。README 与两个 manifest 的路径已同步，原路径保留供溯源。

更新 8 份 .gitignore：工作区根、api、web、API_Go、APP、API_Main_Git、Docs 与 build-strp。屏蔽测试目录/测试文件/测试配置、日志和截图、temp/tmp、备份与导出、本地环境和签名凭据；根目录另屏蔽本地 agent 状态。保留 .env.example、SQL schema/migrations、生产源码与业务 data 目录；web/.env.production 仅含公开 CSP 构建配置，继续保留。

独立 Git 仓库中，单加 ignore 不会影响已跟踪文件。本次按精确路径仅取消跟踪，所有本地文件保持原字节：

| 仓库 | 取消跟踪项 |
|---|---:|
| api | 53 |
| web | 9 |
| API_Go | 15 |
| APP | 1 |
| API_Main_Git | 32 |
| 合计 | 110 |

包含测试、测试配置、日志/截图，以及带开发登录凭据的 web/.env.development。修改前各仓库均无已暂存内容；index 已备份，本次新增的暂存变更仅为所列文件的取消跟踪。未删除本地测试、环境或日志，没有提交或推送。

验证：各仓库不再跟踪测试和日志；git check-ignore 校验本地材料被屏蔽，生产源码、迁移、环境示例和公开 CSP 配置可继续跟踪。测试文件、本地开发环境、脚本归档与 ZIP 均保留。此次仅移动归档、修改文档/ignore 和取消跟踪，不改生产或测试逻辑；沿用前次 API 217 套 / 4846 项、Web 350 项与构建通过的验证，不重复运行模型、数据库或全量测试。

Ignore 原文件、Git index 与精确取消跟踪清单见 `temp/ai-ignore-20261111`；归档移动前后指纹见 `temp/ai-v1-v2-cleanup-20261111/archive-relocation.json`。

---

## 来源：CHANGELOG_2026-11-11_AI_V1_V2_CLEANUP.md

# V1/V2 遗留安全清理（2026-11-11）

按 [清理前审计](REVIEW_2026-11-11_AI_V1_V2_LEFTOVERS.md) 执行，保留 V3 当前功能、历史恢复和真实安全边界测试。

## 完成的清理

- **旧脚本归档 28 个**：从 api/tools 移出，归档现按用户要求放在 `temp/ai-v1-v2-cleanup-20261111/archive/scripts/*.js.txt`；原始内容共 308057 字节，逐个 SHA-256 一致。包含 13 个直接 V2 请求脚本、3 个旧编排真实验收入口及其专用场景/服务依赖。归档不提供 npm 执行入口。
- **移除 3 个旧 npm 真验收命令**：ai:real:acceptance、ai:real:ocr、ai:business:provider。test:ai:v2 改为 test:ai:shared，并纳入新的生产共享服务安全测试。
- **后端 V1**：生产 service/index.js 删除 run、saveTransactionCandidate、continueTransactionCandidate、proposeTransaction 四个旧方法；旧聊天专用 import 和预算注册同步移除。历史测试通过显式 legacyAiService 夹具追加旧方法，共享设置、OCR、草稿和执行仍调用真实生产实例。夹具强制隔离仓库与供应商注入，取消默认真实供应商兜底。
- **后端 V2**：businessService.js 从 499 行精简到 67 行，仅保留 V3 会话及提案读写、核对、执行能力。生产 businessScope.js 移除；旧编排/范围进入明确的 test-only 夹具，共享操作直接委托当前生产模块。
- **前端**：删除无引用的旧 AiAuthDialog.vue，移除 askAi、getAiConversationMessagesSince、clearAiSettings 三个包装。四个旧专用校验器移出生产源码、进入测试夹具，历史安全测试继续执行。有效的非流式 V3 askAiBusiness 保留。
- **零散接线**：删除 callLog/preferences 的未使用 db import、v3ResultAssembly 的未使用 scrubModelProse import 和 clarificationOnly 解构接线。
- **文档**：当前 V3 README 去掉重复旧正文及旧验收推荐，链接历史留档；api/README.md 修正当前 V2 描述并添加本次索引。历史记录保持原文，仅标注清理前基线与后续状态。

## 保留的当前能力

V3 非流式/SSE 聊天、独立 OCR、contractVersion 1 图片与旧历史恢复、资金预检、草稿编辑/核对/入账、提案执行、授权和请求预算均保留。公共读层、tools 的草稿校验、SQL 权限验证、当前 019 合并迁移及现有 V3 真库测试入口继续有效。

ai-fullscene-setup.js 仍被当前 V3 setup 使用，独立历史证据汇总也保留。temp 旧证据、数据库历史、迁移 SQL 与已明确 `.skip` 的旧真库留档没有批量清理。

## 验证结果

| 验证 | 结果 |
|---|---|
| API 默认完整离线回归 | **217 套 / 4846 项通过，0 失败、0 跳过** |
| Web 全部测试 | **350 项通过，0 失败、0 跳过** |
| Web 生产构建 | **通过** |
| 归档原始字节 / SHA-256 | **28/28 一致** |
| 生产到 test-only 夹具引用 | **没有** |

API 使用 `node node_modules/jest/bin/jest.js --runInBand --silent --verbose=false --json --outputFile ../temp/ai-v1-v2-cleanup-20261111/api-full-regression-final.json`；Web 使用 `node --test tests/*.test.mjs` 与 `npm run build`。

全量首轮发现 3 套 / 5 项测试仍引用已移出的旧包装或冻结工具，已改用生产 createFinancialWorkflow.candidate 和当前迁移入口，保留原有归属、禁止来源、防重放断言。首轮红记录保留在 `temp/ai-v1-v2-cleanup-20261111/api-full-regression.json`，最终记录独立保存，不覆盖历史失败。

独立 AST 对比确认 V1 的其余方法与辅助函数不变，包括 runOcr、资金预检、批量持久化、草稿编辑和提交；V2 会话/提案共享逻辑保持一致。OCR 预算包装仅移除旧 run 条目。没有运行真实模型、真实数据库、归档脚本或迁移命令。Jest 的现有 ignorePatterns 提示未在本次清理中调整。

## 备份与恢复

完整原文件快照见 [temp 归档与备份说明](../../temp/ai-v1-v2-cleanup-20261111/archive/README.md)，精确变更见 [清理 manifest](../../temp/ai-v1-v2-cleanup-20261111/archive/cleanup-manifest.json)。修改和移出前的原文件均收录在 before.zip；新增文件也在 manifest 中标注，便于按需回退。原分组备份和验证输出保留在 `temp/ai-v1-v2-cleanup-20261111`。

恢复旧编排应在隔离的对应旧版本工作区进行。当前 V3 不重新开放旧入口；生产路由的 410 保护和验证它的测试继续保留。

---

## 来源：CHANGELOG_2026-11-11_AI_V1_V2_LEFTOVERS_AUDIT.md

# V1/V2 迁移 V3 后遗留盘点（2026-11-11）

核对当前 AI 生产入口、前后端调用关系与旧验收脚本，确认旧入口退役后仍保留 V1 run、V2 preview/chat/cancelPreview、旧专用包装与前端无引用组件/方法。

api/tools 中 13 个脚本直接请求退役 V2 路径；3 个 npm 真实验收入口仍直接调用旧编排或混合旧聊天步骤。当前文档还有旧验收推荐。已明确区分这些残留与 V3 仍使用的 OCR、历史兼容、会话/提案、草稿执行、共享校验和迁移。

旧九场景真库套件已改为 aiRealChain.v2-retired.realtest.js.skip 留档，不在当前真实测试匹配范围；当前 test:ai:real 与 test:ai:v2 的共享测试不能整体删除。

运行现有离线路由定向回归：1 套 / 2 项通过，10 项按筛选跳过。验证旧端点返回 410 不触发聊天编排、V3 正常转发原话与鉴权身份。未调用真实供应商或数据库。

本轮仅写审计文档与 README 索引，没有清理生产源码。完整位置、调用证据和后续顺序见 [遗留审计报告](REVIEW_2026-11-11_AI_V1_V2_LEFTOVERS.md)。

---

## 来源：CHANGELOG_2026-11-11_AI_V3SERVICE_STEP1_MOVE.md

# v3Service 按阶段瘦身·子步1：呈现函数群纯移动日记（2026-11-11，追加168）

承接[追加167](CHANGELOG_2026-11-10_AI_STAGE1_PROCESS_ACCEPTANCE.md)后的手术②（v3Service 按阶段拆分）。本轮执行子步1，遵守负责人四约束（先列可达状态、提取纯函数、四段顺序保持、每步全量回归）中最可直接落地的一条：**只搬纯函数，不动编排**。

## 改动（2 文件，纯移动）

**新增** `src/modules/ai/service/v3AnswerPresentation.js`（393 行）：从 `v3Service.js` 搬出模块级纯函数群——

- `buildFinalizationMessages`（finalize 消息重构）
- `validateChart`（图表引用校验，公开 re-export）
- `allowedNumberValues` / `sentenceNumbers` / `scrubModelProse`（数字验证 prose 清洗管线）
- `typeSegments` / `markdownCell` / `rowsTable` / `multitaskSavedFacts`（表格与事实投影）
- `buildQueryAnswer`（答复组装，公开 re-export）
- `withScopePolicy`（范围 policy 注入，公开 re-export）
- `redactSelectedText`（选中结果脱敏）
- 随迁局部常量：`DATE_TOKEN_PATTERN` / `NUMBER_TOKEN_PATTERN` / `MODEL_IMPLEMENTATION_SENTENCE`

**修改** `v3Service.js`（1557 → 1186 行）：函数群原位替换为一行 require（仅导入闭包在用的 5 个：`buildFinalizationMessages`/`validateChart`/`buildQueryAnswer`/`withScopePolicy`/`redactSelectedText`），`module.exports` 契约不变（测试导入 `createV3Service`/`buildQueryAnswer`/`validateChart`/`turnTimeoutMs` 全部照旧）；空置 require 行自动修剪（`queryCountRankClaims`/`queryTemporalProse`/`queryDateProse`/`queryCountClaims`/`queryMonthlyProse`/`queryFinancialRankClaims`/`queryDailyConditionClaims`/`queryWindowClaims`/`queryRepaymentProse`/`queryFundProse` 共 10 行整体删除，`queryCoverageProse`/`queryTimestampDisplay` 解构瘦身）。`CHART_INTENT` 被闭包 `:1237` 使用，留在 v3Service。

## 零变化证明

- **逐字节比对**：搬移块与备份基线唯一差异 = 卫星中 `buildFinalizationMessages` 与 `validateChart` 之间多一个空行（原被 CHART_INTENT 注释块隔开的位置）——纯空白，零逻辑变化。
- 结构保证：搬移群全部是模块级函数（定义于 `createV3Service` 之前），语法上不可能引用闭包状态；卫星只依赖模块级 import 与自身常量。

## 验证

| 验证 | 结果 |
|---|---|
| 模块加载冒烟 + 导出契约 | 5 个公开符号全部 function |
| v3Service 导入者套件（呈现/投影/证据/图表/内存 12 个文件） | 403/403 |
| 全量离线回归 | **205 套 / 4473 项全过，0 失败**（并行会话此前 3 项失败已由其收口） |

## 边界与子步2 前置

- 本轮未触碰 `createV3Service` 闭包内任何代码：授权复验→声明校验→事务提交→恢复载荷顺序原样。
- **子步2（claims 管线出闭包）前置**：需先盘点闭包内 claims 归一化调用点所依赖的可变状态（`taskContext`/`queryContext`/`usage`/`egress` 等），列出实际可达状态（openMode/relaxedMode 由 request.mode 派生、部分 taskContext relaxedMode 下禁用），再决定提取形态——避免搬出后仍传巨大可变 context（负责人约束）。
- 未打包；web 未动。

## 证据

`../../temp/ai-stage1-processes-20261110/api-regression-postmove.json`。备份基线仅存于临时目录用于比对，不入库。

---

## 来源：CHANGELOG_2026-11-11_AI_V3SERVICE_STEP2_ASSEMBLY.md

# v3Service 瘦身·子步2：答复组装阶段出闭包日记（2026-11-11，追加169）

承接[子步1](CHANGELOG_2026-11-11_AI_V3SERVICE_STEP1_MOVE.md)。执行计划与状态盘点见
[PLAN_AI_V3SERVICE_STEP2.md](PLAN_AI_V3SERVICE_STEP2.md)（含可续接锚点与执行结果补记）。

## 改动（2 文件）

**新增** `src/modules/ai/service/v3ResultAssembly.js`（103 行）：`assembleTurnResult(facts, artifacts)`
——原 `createV3Service` 闭包内 `buildResult`（:1049-1118）的逐字搬移。承载三合一阶段：
查询后处理（emptyFacts/buildQueryAnswer/withScopePolicy/coverage/chart presentation）、
终稿声明校验（`assertResultClaims` 调用点）、结果与恢复载荷组装（result/appendPayload/
finalizeQueryContext/finalizeTaskContext）。

**facts 46 键显式枚举**：调用点（v3Service 内 `const buildResult = artifacts => assembleTurnResult({...}, artifacts)`）
逐名列出轮内事实快照，惰性求值（answer/usage/nextPendingContext 等按调用时值）；不含任何
闭包函数引用除 `egress.scrub`/`budget`（读 .calls）/`now` 三个显式传入的边界。负责人约束
「不传巨大可变 context」以此形态满足：枚举即声明，卫星收纯数据。

**修改** `v3Service.js`（1186 → 1127 行）：buildResult 原位替换为惰性枚举调用；import 修剪
（assertResultClaims/reconcileMemoryClaims/queryCoverageProse 整行、queryEmptyFacts/
queryDisplayOrder/queryCardLimitChartNotice/queryChartCoverage/queryRangeProse 整行、
queryTimestampDisplay 整行、attachQueryResults 删名——13 个名字随迁卫星）；
`finalizeQueryContext`/`finalizeTaskContext`/`upsertTaskContext`/`attachQueryCoverage`/
`selectQueryTaskBinding` 闭包另有使用，双边导入。

## 过程中的三个真问题（均已修/已定性）

1. **TDZ 命名冲突**：函数体本地 `const answer`（组装后答复，:1091）与模型原始答复 fact
   撞名——首次提取把 `output.answer` 替换为 `answer` 导致体内在本地声明前引用（TDZ）。
   修复：fact 命名 `modelAnswer`。该问题被目标套件当场咬住（4 failed），非静默。
2. **并行撞车（provider 流式切换）**：并行会话同期把 v3 provider 默认值切为
   `deepseekChatStream`（v3Service.js:14-16，2026-11-11 注释），真库套件 S3/S5 转红——
   失败面为传输层（mock harness 尚无 v3 SSE 脚本 → stream 请求收到 JSON → "Invalid
   response" → AI_PROVIDER_FAILED），与本次提取无关。单点翻转实验（stream→非流式）
   反而 6 项全挂（其在途状态含其它协同改动），已即时还原；还原后复跑离线确认无损。
   真库套件复绿归并行会话收口。
3. **两段实为一体**：原计划的「终稿校验段」「查询后处理段」盘点后发现是同一函数
   （buildResult），合并提取——计划文件盘点表有完整依据。

## 零变化证明

buildResult 函数体与提取前基线**逐字节一致**（仅三处机械替换：`output.answer`→`modelAnswer`、
`conversation.id`→`conversationId`、`maxProviderCalls: MAX_PROVIDER_CALLS`→facts 键；比对窗口含
函数收尾符为工具假象）。四段顺序不变：assertResultClaims 仍在授权复验与 saveV3Recovery/commit
之间；withScopePolicy 原地换元的同一数组引用语义保持（result.datasets === 传入 readDatasets）。

## 验证

| 验证 | 结果 |
|---|---|
| 模块加载 + 导出契约 | createV3Service/validateChart/buildQueryAnswer/withScopePolicy/turnTimeoutMs 全部 intact |
| 目标套件（呈现/自然语言答复/空查询覆盖/投影回归） | 71/71 |
| 全量离线（提取后、撞车共存态） | 205 套 / 4474 项 0 失败 |
| 翻转-还原后全量离线 | 205 套 / 4474 项 0 失败 |
| 真库套件 | S1 进程重启绿；S3/S5 红=并行流式切换在途（传输层），归其收口 |

## 阶段结构现状（手术②累计）

- `v3AnswerPresentation.js`（393 行，子步1）：呈现纯函数群；
- `v3ResultAssembly.js`（103 行，子步2）：答复组装阶段（显式 facts 契约）；
- v3Service.js 1557 → 1127 行，剩余主体 = 编排闭包（provider 循环/工具分发/提案管线/事务）。
- **子步3（claims 规则表化）前置已满足**：assertResultClaims 调用点已进纯模块；
  规则表化动 v3Claims.js + query*Claims 卫星，不再触碰编排闭包。

## 证据

`../../temp/ai-stage1-processes-20261110/api-regression-step2.json`（4474）、
`api-regression-step2-final.json`（还原后 4474）。未打包；web 未动。

## 复绿验证补记（2026-11-11，并行会话收口后）

并行会话完成 v3 流式切换收口后复跑：真库套件 **7/7 全绿**（S1×2/S2/S3×2/S4/S5，含跨进程与真实重启），
全量离线 **217 套 / 4846 项 0 失败**（合并稳态：子步1+2 提取 × 流式切换 × 僵尸行修复共存的回归基线，
套件 205→217、用例 4474→4846 为并行会话增量）。子步2 在合并态的验证就此闭环。

---

## 来源：CHANGELOG_2026-11-11_AI_V3SERVICE_STEP3_CLAIMS.md

# v3Service 瘦身·子步3：claims 规则表化日记（2026-11-11，追加170）

承接[子步2](CHANGELOG_2026-11-11_AI_V3SERVICE_STEP2_ASSEMBLY.md)。执行计划与规则盘点表见
[PLAN_AI_V3SERVICE_STEP3_CLAIMS.md](PLAN_AI_V3SERVICE_STEP3_CLAIMS.md)；需求/设计依据
`.codeartsdoer/specs/claims_rule_table/`（spec.md + design.md D1-D7 + tasks.md）。

## 改动（2 文件）

**改写** `src/modules/ai/service/v3Claims.js`（161 → 223 行）：散落规则收敛为声明式规则表，
组织层次 = 词素 → 规则表 → fail-closed 守卫 → 机制函数 → 主循环：

- **词素 LEXICON**（9 个 const 归组）：DONE/DRAFT/MAKE/GAP/DATA_NOUN/ACTION/MONEY_ACTION/SUBJECT/BRIDGE，
  原 :6-9/:19-22/:35 三处分散常量集中为全部 pattern 模板插值的唯一正则文本来源；
- **CLAIM_RULES**（12 条目 = draft 4 + execution 8）：pattern（模板插值/字面量逐字随迁）+ kind +
  requiresComplete（draft 全部显式 true，D2）+ note（:28-29 英文注释随迁至 MONEY_ACTION 条目）；
  表序 = 原数组序；draftPatterns/executionPatterns 改为从表按 kind 过滤派生（加载期一次，
  主循环引用名不变）；
- **AFFIRMATIVE_RULES**（5 键）：negativePrefix/futurePrefix/history/explicitCurrent + :51 内联
  英文条件正则提常量 englishConditional；affirmative 判定序（否定→将来→英文条件→历史⊕显式当前）
  逐字保持；
- **continuation 规则域**：completedContinuation 主正则、continuationBusinessObject、
  CONTINUATION_SENTENCE_SPLIT（:77 切分）提具名常量；CONTINUATION_GUARDS 三阶段守卫表
  （prefix 3 / action 1 / tail 2 条目 = 原 8 处谓词判定，:88 双条件拆两条目）；
- **EFFECT_RULES**（3 条目，表序 = 原 if 序 ledger→delete→update）+ payment 兜底保持代码内联（D4）
  + EFFECT_WHITELIST；
- **RECEIPT_RULES**（4 条目）：ledger 精确相等谓词与 delete/update/payment 后缀正则谓词两种形态
  并存（D3）；字段有效性校验留在 some 回调首段；
- **双层 fail-closed 守卫**：L1 加载期结构守卫 assertRuleTablesIntact()（六项断言，结构性漏配 =
  require 时抛 AiError 500 'AI_INVALID_RESULT'）；L2 运行时分类白名单（effectOf 返回点，
  白名单外抛 AI_RESULT_CLAIM_MISMATCH 502，claimType=分类值）——正常路径均不可达；
- **机制函数**（unquoted/matches/affirmative/hasId/pending/complete/mismatch）逐字保留仅改读表；
  主循环 assertResultClaims 控制流逐字保留（:152 完整草稿复验词面提 COMPLETE_DRAFT_PATTERN 常量）；
- **导出契约冻结**：`module.exports = { assertResultClaims }` 不变。

**修改** `v3Service.js`（1127 → 1126 行）：删除 :31 空置 import
`const { assertResultClaims } = require('./v3Claims');`（子步2 遗留死代码，grep 复核闭包内零引用）。

## 零变化证明

- **正则集合 diff 为空**：改造前后全部 RegExp source+flags 集合 35 → 35，diff = EMPTY
  （审计工具 `step3-regex-audit.js`：剥注释源码扫描字面量 + 临时副本导出深度枚举，两边同算法）——
  零正则语义改写、无合并/拆分；
- **条目数对账一致**：draft 4 / execution 8 / continuation 主正则 1 + 切分与业务对象常量 2 +
  守卫表条目 6（= 原 8 处谓词判定）/ effect 3+兜底 / receipt 4 / affirmative 5 / complete 词面 1
  （审计脚本 `step3-entry-audit.js`）；
- **导出契约**：`Object.keys(require('./v3Claims'))` === `['assertResultClaims']`；
- **四段顺序不变**：v3ResultAssembly.js:8 require 与 :45 调用行 diff 为空（assertResultClaims
  仍在 authorize 与 saveV3Recovery/commit 之间）；
- **守卫纯新增**：无新增 require（仍仅 errors）、无模块级可变状态、正则加载期构造一次、
  matches 的 lastIndex=0 + matchAll 语义逐字保留。

## 验证

| 验证 | 结果 |
|---|---|
| 基线复跑（改码前） | 205 套 / 4474 项 0 失败 |
| import 修剪后全量 | 205 套 / 4474 项 0 失败 |
| 导出契约冒烟 + L1 守卫随加载 | exports=['assertResultClaims']，无抛错 |
| 正则集合 diff（35→35） | EMPTY |
| 条目数对账 | 一致（见上） |
| claims 家族定向套件（20 套直连 + aiV3Contract） | **20 套 / 696 项全过**，6.787s → 6.274s（-7.6%，±10% 门禁内） |
| 全量离线（改码后 ×2，含最终状态） | **205 套 / 4474 项 0 失败** |
| 消费方调用行 diff | v3ResultAssembly.js :8/:45 零修改 |

## 过程中的两个真问题

1. **逐字随迁笔误被冒烟当场咬住**：continuationBusinessObject 重写时丢失末尾闭括号 `)`（资产登记
   分组未闭合），SyntaxError 在模块加载冒烟即抛——非静默，加回后复验。教训：逐字随迁的收尾
   符（闭括号/斜杠）与函数体一样易漏，加载冒烟是逐字校验的第一道网。
2. **edit 报成功未落盘（并行覆盖嫌疑）**：v3Service 修剪 import 行后残留一个空行，edit 删除空行
   报成功但复查仍在（疑似并行会话同窗口写入覆盖）；改用 sed 删行 + 立即行数/内容验证（1126 行）
   + 全量复跑确认。教训与 feedback-parallel-sessions 一致：改后必须立即以磁盘为准复核。

## 问题 2 后续闭环（落档后排查，2026-11-11 12:12）

落档后 mtime 痕迹排查发现 `v3Claims.js` 与本日记 12:11 存在晚于本轮写入的外部触碰痕迹。
完整性复核：v3Claims 223 行 / 五张表+守卫关键结构 / 导出键 / 正则集合 diff（old vs recheck）
35→35 EMPTY / 全量 205 套 4474 项 0 失败（第 5 次）；日记重读逐字一致——**均为 touch 级
无内容变化**，按并行会话规矩（mtime 变但内容一致不算冲突）不覆盖不返工；落档口径与磁盘
现状一致。问题 2 的"写后立即磁盘复核"防线在本轮实际咬住过一次（v3Service 空行残留），
有效性确认。

## 阶段结构现状（手术②累计）

- `v3AnswerPresentation.js`（393 行，子步1）：呈现纯函数群；
- `v3ResultAssembly.js`（103 行，子步2）：答复组装阶段（显式 facts 契约）；
- `v3Claims.js`（223 行，子步3）：声明校验规则表化（五张表 + 双层守卫）；
- v3Service.js 1557 → 1126 行，剩余主体 = 编排闭包（provider 循环/工具分发/提案管线/事务）。
- **后续候选**：卫星 query*Claims/query*Prose 家族 12 模块表化留待后续子步（D6 裁定：每模块
  独立提交可回退；queryWindowClaims 173 行密集判定收益低风险高）。

## 证据

`../../temp/ai-stage1-processes-20261110/`：step3-regex-audit.js（正则审计工具）、
step3-entry-audit.js（条目对账）、step3-regexps-old.json（改造前 35 正则快照）、
step3-regexps-new.json（改造后 35 正则快照）。未打包；web 未动。


---

## 来源：CHANGELOG_2026-11-11_AI_CLONE_DB_CLEANUP.md

# AI 验收克隆库清理（2026-11-11）

## 背景

同日 /ai 巡检查库时发现实例留存四个 AI 验收用一次性克隆库，验收完结、证据在档但库体悬置。负责人批准删除。

## 动作

1. 证据核对：四个库名均在 CHANGELOG_2026-11-07/08/10.md 及 about-ai/ 验收 JSON 中在档。
2. 删前快照落档：`api/logs/about-ai/AI_CLONE_DB_CLEANUP_2026-11-11.md`（含各库表数、ai 表数、关键行数）。
3. 执行 `DROP DATABASE` ×4，脚本内置精确库名白名单 + 正则校验 + 保护名单（live_dev/live_ai_test/live 等）断言。
4. 执行后 `SHOW DATABASES` 校验：4 库消失、保护库完好（实例 schema 26→22）。

## 结果

- 已删：ai_fault_verify_20261106_7fcec62f、ai_s2_verify_20261106_8d6fae7e、ai_fullscene_20261107_dcd7fbe5、aiacc_20261110_1257
- 保留：live_dev（日常库，ai 表 15 张仅 ai_background_job 空=主动智能未实施）、live_ai_test（tests/real 专用）、live（生产，暗发布未执行）
- 附带结论：ai_readonly 视角 0 张 ai 表为授权面设计（同库异权，ai_* 运营表走应用主账号）


---

## 来源：CHANGELOG_2026-11-11_AI_A_S9_S10_IMPLEMENTATION.md

# AI Agent A calc / §9 预算进库 / §10 历史 token 化 实施与验收（2026-11-11）

## 范围

按 PLAN_AI_AGENT_CAPABILITIES.md 三项一次实施：A calc（§3）、预算配置进库（§9）、历史上下文 token 化截断（§10）。B failover 已于同日否决存档（§4）。启动门槛已开（六步 3/4=追加168-170、5=追加167）。

## A · calculate 确定性计算工具（§3）

- 新 `service/calcTools.js`：词法级白名单求值器（数字/四则/取模/幂/括号/常量 pi e），不用 eval/Function；BigInt 十进制定点（s×10^-k）消除浮点尾差；money 模式四舍五入到分并给整数分字符串 cents，number 模式 15 位内精确输出；除不尽置 approximate=true 并经运算传播；除零/溢出/非法表达式分类拒绝（AI_CALC_INVALID_EXPRESSION / AI_CALC_DIVIDE_BY_ZERO / AI_CALC_OVERFLOW / AI_CALC_ARGUMENT_INVALID）。数字字面量限整数 12 位、小数 6 位，表达式 ≤200 字符 ≤120 token。
- 注册：v3Service definitions 追加（第 9 个原生工具）；runTool 内 `isCalcTool` 分支置于一切授权检查之前（纯本地无出域无副作用）；runCalcTool 记账口径与 runContextTool 一致（预算锁定/去重缓存/字节上限/tool 事件审计含表达式与结果）；参数或算式错误以 status:error 反馈模型重试不中断整轮。operate 模式 OPEN_DEFINITIONS 同步纳入（openConversation.js），OPEN_SYSTEM_PROMPT 补一句派生数字纪律。
- v3Prompt 新增「派生数字纪律」段：账本之外的派生数字必须走 calculate 不得心算；结果不得与账本冲突；% 是取模，百分数写作除以 100。
- 验收：calcTools 单测 18/18（四则/幂/括号/常量、除零、溢出、非法逐类、金额定点、近似传播）；aiV3Service 全链路新增 2 用例（求值进 toolTrace+答复含 4512.50；非法算式 status:error 不中断整轮）；工具清单契约断言 8→9 更新。
- 实施偏差说明：计划验收项「真库场景断言调用了 calculate」由 aiV3Service 离线全链路用例承担（calculate 不触库，真库 harness 的 mock provider 尚不支持脚本化 tool_calls，扩展 harness 超出本项改动清单边界）。

## §9 · 预算/超时六项配置进库

- live.sql 新增 `ai_config` 单行表（CHECK id=1）：daily_provider_calls / max_usage_tokens / max_output_tokens / provider_timeout_ms / turn_timeout_ms / history_tokens 六列全 nullable，NULL=跟随 env 缺省；无行=现状逐字节一致。用户可写面之外（ai_provider_profile 是用户可写表，不承载预算）。
- 新 `service/aiConfigStore.js`：仿 settings.js 两级结构（L1 同步缓存 + L2 表 warmup）；SWR 惰性刷新 ≤60s；无 executor=纯内存模式（单测「不碰公共库」铁律，默认参数不绑库，生产组合根 api/index.js 显式传 executor）；启动降级——表未建/不可达时按纯 env 模式运行不阻断 AI。
- 生效链：aiConfigStore→providerEnv 注入 env 槽位→所有 getConfig 调用点自动生效，边界校验每请求重跑（越界 AI_CONFIG_REQUIRED 与 env 非法同路径）。
- tests/real/liveSchema.js EXPECTED_TABLES 41→42；aiLiveSchemaDdl 计数断言同步。
- live_dev 已建表并加列（运维步骤完成）；ai_readonly 复核仍 18 张表、看不到 ai_config（授权面隔离实证）。运维启用示例：`INSERT INTO ai_config (id, daily_provider_calls) VALUES (1, 150) ON DUPLICATE KEY UPDATE daily_provider_calls=150, updated_at=…`，≤60s 生效。
- 验收：aiConfigStore 单测 7/7（无行空覆盖/NULL 下发/六列全覆盖/表未建降级/SWR 刷新/getConfig 生效与越界拒绝）。

## §10 · 历史上下文 token 化预算

- 实施发现：估算器 estimateTokens（CJK 加权）与预算选择器 selectBudgetedHistory（保最近轮+omitted 摘要）已在 modelContext 存在并接入 v3Service——本轮缺口实为「预算来源」。
- 预算解析链（modelContext.historyTokenBudget(config)）：config.historyTokens（含 ai_config.history_tokens 覆盖）> env.AI_CONTEXT_HISTORY_TOKENS > contextWindowTokens/3（上限 12000，留系统提示/工具定义/输出余量）> 3500；有效域 500~12000，非法静默回落（沿用既有容忍语义）。v3Service 历史装载传入 initial.config。
- config.js 新增 historyTokens 字段（含 ai_config 经 providerEnv 注入 AI_CONTEXT_HISTORY_TOKENS 槽位）。
- 已知行为变化：known 模型（商汤/GLM，window 1M/204800）长对话历史预算 3500→12000（§10 目标即长对话质量）；短对话逐字节不变（套件实证）。
- 验收：aiModelContext 新增 2 用例（解析链七断言+provider-aware 预算界），连同存量估算器/选择器/摘要用例全绿。

## 回归

- test:ai 4503/4503 全绿（含新增 27 用例）；test:ai:real 7/7 过（live_ai_test 按新 DDL 重建，42 表断言通过）；全量离线回归 219 套/4874 项 0 失败（净增 2 套/28 项）。

## 修改清单

新增：service/calcTools.js、service/aiConfigStore.js、tests/unit/calcTools.test.js、tests/unit/aiConfigStore.test.js；修改：service/v3Service.js（注册+分支+runCalcTool+历史预算）、service/openConversation.js、service/v3Prompt.js、service/modelContext.js、service/config.js、service/index.js、modules/ai/api/index.js（组合根）、mysql/live.sql（ai_config）、tests/real/liveSchema.js、tests/unit/aiV3Service.test.js、tests/unit/aiModelContext.test.js、tests/unit/aiLiveSchemaDdl.test.js。
