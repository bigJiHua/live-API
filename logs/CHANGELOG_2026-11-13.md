# 2026-11-13 变更记录

## API 主 README 目录与接手入口更新

按当前目录、路由、`package.json` 和环境说明更新 `api/README.md`，不改业务代码或运行配置。

- 重画项目结构：补 `tools/`、`common/services/`、AI `api/service`、集成测试、评测、真库测试和 `data/personalization/`；删除不存在的 `scripts/` 及“集成目录尚未建立”说明，补齐迁移 019/020 与公开资源位置。
- 增加导航、当前状态和最新日记入口，将旧验收明确标为历史；补 AI、个性化、搜索功能及实际 23 个路由组，区分 Go/Node 能力、探活与分享 SSR，修正握手 GET 及 `res.say` 响应示例。
- 更新首次配置保护、环境检查、AI 同库只读/加密连接/预算优先级、测试和运维命令；保留生产与付费测试的独立授权边界。
- 修复 78 个失效文件路径（85 处链接）：57 个合并日记路径、21 个精确同名归档；不改写历史失败或验收计数。

验证：README 163 处本地文件链接全部存在，目录树 96 个具体路径全部存在，17 个文档 npm 脚本均在当前 `package.json` 定义；实际模块/路由组/建表数为 20/23/42，代码围栏配对及 `git diff --check` 通过。仅有 Git 的 LF→CRLF 提示。未运行业务测试、构建、服务、数据库或付费模型/搜索；上述阶段验收数字引用既有记录，不代表本次复跑。

## 第一阶段阶段性收尾与独立校验

负责人要求复核另一执行者回归后结束第一阶段。源码254个JS文件摘要与冻结、真实报告一致；API232套/5266项、Web501项、隔离真库10项及商汤原8场8/8均与原始日志一致。逐请求核对32次主对话provider.done及回执/历史判定。

校正两处收尾口径：完整日志还有1次异步画像provider.start，没有done；隔离遗留执行行provider_calls=1通过原guard过期读取收割为AI_TURN_INTERRUPTED，保留证据、不重试，不能称本轮所有尝试仅32次。个性化state.json实际在独立data/personalization，本次补1文件/5219字节加密归档与恢复一致，原目录未改；运行手册明确memory与personalization两份归档配套恢复。字段加密取钥描述也按实际兼容规则校正。

仅修改运行手册、阶段状态与校验文档，没有改运行时代码、.env、正式业务数据，没有新增供应商调用或生产发布。第一阶段基础开发阶段性收尾；自然语言/图表口径瑕疵、搜索真源、生产和进一步能力扩展保留独立后续边界。证据与范围见 [STAGE1_CLOSEOUT](../../temp/api-logs-archive/ai-stage1-closeout-20261113/STAGE1_CLOSEOUT.md)。

## AI 扩展接入与试行基础

工具定义/分类器/校验器与实际分发绑定，漏接即拒绝；新增服务端灰度名单，保留退出试行后的回执读取与原人工确认语义。生产DB准入缺省6次/分钟，开发/测试30，原模型/工具预算保留。新增记忆加密备份与新目录恢复工具，V3接入、契约兼容和试行手册同步。

API默认AI回归232套/5266项通过；新真MySQL/HTTP专项3项通过（本地脚本provider）；当前记忆2文件/4319字节真实加密备份、恢复hash一致。副本源库26张业务表、memoryRoot、.env及冻结源码前后hash一致。负责人最新指令要求改完交接给另一执行者回归，真实商汤8场与Web完整回归未执行，不宣称新8/8或生产可开闸。

交接、修改清单、冻结摘要、逐项证据与真实回测命令见 [HANDOFF](../../temp/api-logs-archive/ai-foundation-20261113-7d2c/HANDOFF.md)。实际供应商在live回测前必须锁定token.sensenova.cn/sensenova-6.8-flash；现有账号接入商配置不改。

## AI 画像实机修复与最终验收

原画像生成硬编码 30 秒截止，忽略供应商配置；延长等待后仍输出截断。实机诊断确认，当前 maas 网关的 4096 个输出 tokens 全部用于思考，思考 8401 字符、正文为空：应用的 `thinking:false` 没有转换为实际关闭字段。

- 精确 HTTPS origin `https://maas.qianwenaiapi.com`、型号 `deepseek-v4-flash-0731`、`config.thinking === false` 的组合发送 `thinking:{type:'disabled'}`，已实测有效；其余未知能力及 4096 token 上限保留。
- 供应商超时遵循合法配置 1000～105000 毫秒、默认 60000，守卫预留 10 秒；前端及画像端点代理模板为 180 秒。生成最多 12 项、正文 120 字、证据 2 段各 100 字；输出按真实模型、显式配置及总预算收窄，当前 4096 tokens 最多 6 项。超预算或不完整结果保留已有画像，不自动重试。
- 失败自动尝试增加默认 30 分钟的进程内冷却，成功间隔保留；手动重新整理可立即发起，每批仍最多一次模型调用。
- 重建仍限最近 80 条，保留未检查来源的旧推断及手工、确认项。裁剪后保存实际处理游标，仅可信内部重建可用 `allowHistoryRewind` 回退；公开请求和普通 AI 更新禁止回退。画像存储 100 项、既有模型窗口 30 项保留。

最终真实 HTTP 验收：72 条合成原话、23404 字符，HTTP 200，**3524 毫秒生成 6 项**；正文 903 字符、输出 330 tokens、无思考字段，`finish_reason=stop`。逐字证据、持久化及真实预算回执 `completed/providerCalls=1` 通过；实际用户画像和聊天历史未改写，隔离目录已清理。

本轮 HTTP 画像排障与验收累计 **5 次真实供应商调用**，每次单独发起；失败均保留，没有自动重试，以下记录不与早前独立 GLM 试验混计：

| 次数 | 样本与结果 | 独立证据 |
|---|---|---|
| 1 | 4 条合成原话；HTTP 成功，生成 5 项 | [小样本结果](../../temp/api-logs-archive/personalization-profile-http-small-live-result.json) |
| 2 | 72 条长历史；原 3200 token 输出截断，结果未保存 | [长度失败结果](../../temp/api-logs-archive/personalization-profile-http-length-live-result.json)、[当次原始报告](../../temp/api-logs-archive/personalization-profile-http-live-result.json) |
| 3 | 容量与 6 项限制修复后；实际 4096 tokens 仍截断，HTTP 502 | [容量修复后失败](../../temp/api-logs-archive/personalization-profile-http-fixed-live-result.json) |
| 4 | 保持请求字段不变诊断；4096 tokens 全部用于思考，正文为空 | [输出通道诊断](../../temp/api-logs-archive/personalization-profile-http-output-diagnostic-result.json)、[诊断日志](../../temp/api-logs-archive/personalization-profile-output-diagnostic.log) |
| 5 | 精确关闭思考后；HTTP 200，6 项逐字证据与持久化通过 | [最终实机结果](../../temp/api-logs-archive/personalization-profile-http-thinking-disabled-final-result.json)、[最终实机日志](../../temp/api-logs-archive/personalization-profile-thinking-disabled-final.log) |

最终完整验证：[API **228 套 / 5227 项通过**](../../temp/api-logs-archive/personalization-timeout-api-closeout.log)、[Web **451/451 通过**](../../temp/api-logs-archive/personalization-timeout-web-final.log)、[Web 构建成功](../../temp/api-logs-archive/personalization-timeout-web-build.log)。阶段计数不相加；一次性脚本均在 `temp/api-tools-oneoff/`，最终入口为 `personalization-profile-http-thinking-disabled-final.cjs`。

当前本地 Vite `5173` 与 Nodemon API `7788` 已自动加载变更。反代示例只更新模板，未部署远端；上述 HTTP 工厂验收未覆盖生产完整登录／握手，也未完成手机实际页面验收。本次未新增权限功能。

## AI 记忆管理、用户画像与自定义规则

新增「聊天设置 → AI 个性化」入口，用户可直接维护长期记忆，查看并修正 AI 对自己的了解，保存后续回答需参考的明确规则。本次范围不包含权限功能。

- **记忆**：搜索、查看、新建、编辑、停用、删除、修改记录和版本恢复；聊天中的 AI 修改也记录真实版本。新增 `memory_delete` 工具；整文件删除及空内容 `memory_write.patch` 删除完整记录均须有本轮明确要求和同轮读取的当前版本，不能引用历史请求。部分删除返回 `partialDeleted` 回执，只支持对应记录的删除声明，不能声称删除整份文件或全部记忆。后续步骤失败仍如实报告已发生的记忆变更，相邻账本删除声明继续独立核验。
- **用户画像**：从本人跨聊天的用户原话和启用记忆生成背景、喜好、不喜欢、目标、沟通及工作方式。条目携带可核对的原话来源，AI 初始推断待确认；用户可确认、修正、新增或删除，AI 不覆盖已维护或确认项。支持增量更新、重建及成功聊天后的异步自动整理，默认 8 条新用户消息、30 分钟间隔，每批最多一次模型调用并计入现有日额度。
- **规则与上下文**：最多 30 条规则，可编辑和停用；固定说明放提示词前缀，启用规则、可用画像和记忆索引放入 `TASK_INPUT.personalization`。本轮明确语言要求优先，用户维护画像先于未确认推断。规则本身不新增已有资料授权要求，私有记忆及画像沿用现有资料访问边界。
- **持久化与冲突**：新增本人隔离的 `data/personalization/<SHA256(userId)>/state.json`，保存规则、画像、开关、记忆状态与最多 100 条版本快照。文件原子写入、最新版本 CAS；409 刷新当前状态但保留编辑草稿，不自动重放写入或模型调用。整份或部分删除的内容及来源抑制防止旧历史自动恢复；写正文前先持久化忘记保护，正文失败精确回滚新增抑制，后续归档失败仍保留保护。删除失败精确撤销本次历史记录。恢复或人工重加只解除实际包含内容的抑制。删除当前记忆仍保留有限历史快照用于恢复。
- **前端生命周期**：保存中返回保持编辑面板及输入，空闲返回关闭覆盖层；离页提示草稿，卸载后不接受晚到结果。读取、修改、删除和恢复回执须匹配请求文件和版本。独立开关控制使用记忆、使用画像、自动整理画像。

新增鉴权管理接口：`GET/PUT /ai/personalization`、`POST /ai/personalization/profile/generate`、`GET/POST /ai/memories`、文件读取／修改／删除、修改记录与恢复。管理写操作每人每分钟 30 次；前端入口及 API 保持现有正式鉴权协议，无新数据库迁移。

验证：

- 最终 API 完整 `npm run test:ai -- --silent --verbose=false`：**228 套 / 5186 项全部通过**，包含条件语言、部分删除证据／真实声明、持久化故障和版本恢复的收尾修复。此前完整 **226 套 / 5107 项** 与定向 **9 套 / 257 项** 的记录保留供追溯，计数有交集，不相加。
- Web 个性化、实际 Vue 控件、history 返回、聊天 UI 和生命周期联合回归：**57 项通过**；`npm run build` 成功。三份个性化测试已加入后续 `test:ai` 入口。
- 已配置的 GLM `glm-5.3-flash` 真实模型试验：仅 **1 次调用**，合成 6 条用户原话生成 6 项画像，原话逐条匹配，否定和图表条件保留，全部为 AI 待确认项，隔离存储持久读回一致。约 9.3 秒、1083 tokens，现有预算回执 `completed/providerCalls=1`；未读取实际聊天或改写实际用户画像，临时存储已清理。
- 关键后端语法检查及本次文件格式检查通过。全仓 `git diff --check` 仍发现已有 `service/index.js` 四处行尾空白，本次未改动该文件。

当前限制：原生浏览器检查因本机自动化无法确定窗口状态而停止，尚未完成实际页面视觉验收；真实 Vue 控件操作已通过 jsdom 验证。真实模型试验验证了画像生成，不代表全部真实连续聊天场景已验收。

证据：[API 最终完整回归](../../temp/api-logs-archive/personalization-api-closeout.log)、[API 前次完整回归](../../temp/api-logs-archive/personalization-api-regression.log)、[API 定向回归](../../temp/api-logs-archive/personalization-api-final.log)、[Web 测试](../../temp/api-logs-archive/personalization-web-tests.log)、[Web 构建](../../temp/api-logs-archive/personalization-web-build.log)、[真实画像结果](../../temp/api-logs-archive/personalization-profile-live-result.json)、[前端复核](../../temp/api-logs-archive/personalization-frontend-review.md)、[后端复核](../../temp/api-logs-archive/personalization-backend-review.md)。一次性真实验证脚本位于 `temp/api-tools-oneoff/personalization-profile-live-verify.cjs`。

## WebSearch 授权响应协议修复

用户同意联网能力授权后，后端实际已经保存子授权，但 `PUT /ai/grant` 响应缺少顶层 `grantedAt`，被前端 `validateAiGrant` 拒为「授权白名单不符合协议」，导致弹窗保留、原问题无法继续。仅有联网授权的会话在 GET 时又缺少顶层 `lifetime`、`grantedAt`，刷新后也无法通过协议验证。此前测试手工构造完整响应，未覆盖真实后端输出。

- `service/dataGrant.js`：保存响应补齐顶层授权时间，联网子授权持久化有效期；web-only 会话读回使用子授权的时间与有效期，旧记录按已存起止时间恢复原有效期，无需迁移或重新写入。联网子授权到期后返回合法未授权响应。
- 数据会话保留自己的时间与有效期；当前会话数据授权的 `expiresAt: null` 不再被联网子授权期限替换。
- `web/tests/aiWebSearchGrantContract.test.mjs`：使用真实后端 store、内存 SQL 夹具及 JSON 序列化后走前端验证器，覆盖四种有效期、旧记录、到期门控、数据与联网能力隔离及同意后继续原问题的授权控制器流程。

验证：新增契约回归修复前复现 **9 项失败**；修复后的 WebSearch 测试 **13/13 通过**。后端授权及 V3 接口定向回归 **4 套 / 37 项通过**，后端语法检查通过。Web 完整 `npm run test:ai` **443/444 通过**，剩余 `aiPersonalizationBackGuard.test.mjs` 的关闭弹层历史标记断言单独运行仍失败；该用例只加载 Vue、jsdom 与未改动的个性化返回控制器，不加载本次后端或 WebSearch 测试。未改动该独立问题。本次验证不调用真实数据库或付费搜索源。

## AI 后端波动与重启恢复

原恢复流程有三处断点：自动查询第 15 次约在 42 秒停止，早于后端 45 秒进程租约；单次读取可能在 HTTP 超时开始前挂住；强杀进程没有机会追加失败聊天记录，虽然回执被标成 `AI_TURN_INTERRUPTED`，重试仍永久等待失败历史。模型配置暖机失败还会拦住回执接口。

- `interruptedTurnRecovery.js`：回执确认中断后，取本人 `ai_chat_activity` 的加密原话与会话，按原请求 lane、摘要、mode 和已有 retryOf 复核，再用现有幂等 `appendFailure` 补齐记录；保留原发送时间。活跃请求、不同原话／会话／本人、普通供应商失败与实际已提交结果均不能伪造续跑资格。保留既有 `claimRetry` 的跨端一次性认领。
- 回执 GET 跳过模型设置暖机，普通文本结果与失败回执可直接返回；有卡片的成功结果仍暖机并按原逻辑读取最新业务状态。辅助失败历史修复最多等待 1 秒，慢 SQL 可后台幂等完成，不挡住真实回执。
- 前端只读查询扩为最多 30 次，每次 12 秒超时；停止和离页能结束挂起等待，旧读取晚到不能应用到后续查询。自动查询结束保留明确的手动读取入口。手动查询服务 5xx 及刷新恢复时的连接异常同样继续只读恢复。
- 同步确认当前进程轮次中断时撤销旧流所有权，释放发送忙状态并读原回执；失败回执记录错误码及本地 journal，手动重试先补齐中断历史，再带 `retryOf` 继续原问题。停止后到达的旧响应不覆盖新状态。
- 所有恢复查询不发送新的 AI POST；供应商断开的在途生成不能接回。已保存的完整结果直接恢复，未完成轮次由用户明确重试后产生新请求及相应供应商用量。

验证：后端完整 AI 回归 **227 套 / 5145 项通过**；Web 完整 **450/451 项通过**，唯一失败仍为上述已有个性化弹层历史标记测试。此前恢复、流传输、消息顺序和实际消息组件联合定向 **268 项通过**；后续增加刷新恢复用例包含在完整回归中。Web `npm run build` 成功。后端语法检查通过；已有 `service/index.js` 四处行尾空白仍存在，本次未修改。测试使用内存持久化夹具、真实 guard、会话存储、JSON 接口和控制器，覆盖硬杀租约、历史幂等补齐、一次续跑、本人隔离、已提交结果、设置故障、读取挂起与晚到事件；未强杀实际服务、调用真实数据库／付费搜索或部署生产。

最终补齐零模型本地草稿回执的设置暖机后，后端回执与接口定向 **3 套 / 35 项通过**，最终 Web 构建再次成功。

证据：[后端完整回归](../../temp/api-logs-archive/restart-recovery-api-regression.log)、[后端最终定向](../../temp/api-logs-archive/restart-recovery-api-final.log)、[前端完整回归](../../temp/api-logs-archive/restart-recovery-web-regression.log)、[最终构建](../../temp/api-logs-archive/restart-recovery-web-build.log)。

## AI 试行基础回归复核（另一执行者实测）

接手 [HANDOFF](../../temp/api-logs-archive/ai-foundation-20261113-7d2c/HANDOFF.md) 做回归，不改源码／`.env`／生产。前置闸门：当前 `api/src` 254 文件摘要 `ec2ffb96…` 与冻结 after.json 逐字一致、零漂移，`.env` 未变，源库 `live_mock_20261112`（副本非生产）。

- 离线 API `npm run test:ai -- --silent --no-verbose`：能力门禁 **12 工具／23 数据集**；**232 套／5266 项全通过**，0 失败。
- Web 完整 `node --test tests/ai*.test.mjs`（31 文件）：**501／501 通过**，0 失败 0 取消。
- 真库专项 `AI_REAL_PROVIDER_TEST=0 npm run test:ai:real`（隔离 `live_ai_test`，processlist 确认 0 连接、无其他执行者，严格串行）：**10 通过／4 跳过／0 失败**；`aiFoundation` **3/3**（非试行身份先拒、退出试行后重放无二次供应商效果、生产 6 次/分钟跨 guard 共享），Stage1 多进程/修复面通过，`aiRealProvider` 按付费门控跳过 4 项（不计通过）。
- 真实商汤 8 场定向（付费已授权，**只跑一次**，env 内联不改 `7788/.env`）：端点锁定官方 `token.sensenova.cn`／`sensenova-6.8-flash`（运行前只读预检密文行主机 + 评测脚本主机闸门，**无 routify 等代理替换**），密钥只读复制密文、明文不落盘。**严格判定 8/8 通过、跳过 0、错误 0、实际模型调用 32 次**（4/4/3/5/4/4/4/4）；每场要点／禁止项／语言／数字接地／两读回执／重放零新增／SQL 历史全 true；源码摘要与冻结一致。净资产 `43820.00` 经 calculate 核验，**未重现**早前交接审计的「净资产误写且无 calculate」问题（不同种子 live-domains-v2）。

剩余项与边界：`AI_SEARCH_*` 未配置（`requiresSearch` 用例逐项 SKIP、不计通过，按交接不新增凭据／不开付费搜索）；生产按 `PLAN_AI_PROD_ROLLOUT` 另行决策、**未开闸**；8/8 仅 `sensenova-6.8-flash` × 8 个种子定向用例，**非全量黄金集（32 用例）**、非其他供应商。质量观察（非严格失败，按交接「不为措辞反复付费」只记录不复跑）：8 场 `fallback=是`（措辞异于 scripted 基线）、工具序列 `≠（仅记录）`、个别正文排版碎片化（asset-composition「## 净资产」标题下为空／观察列表缺第 1 项，fund-holdings 段落断裂）。

证据：[回归汇总](../../temp/api-logs-archive/ai-regression-20261113-qoder/REGRESSION_SUMMARY.md)、[商汤报告](../../temp/api-logs-archive/ai-eval/2026-11-13/REVIEW_2026-11-13_AI_EVAL_sensenova-6.8-flash.md)、[离线日志](../../temp/api-logs-archive/ai-regression-20261113-qoder/api-offline.log)、[Web 日志](../../temp/api-logs-archive/ai-regression-20261113-qoder/web-ai.log)、[真库日志](../../temp/api-logs-archive/ai-regression-20261113-qoder/api-real.log)、[商汤日志](../../temp/api-logs-archive/ai-regression-20261113-qoder/api-eval-live.log)。一次性只读脚本均在 `temp/api-tools-oneoff/`。本会话未改任何 `api/src`／`.env`／生产配置，未 git 提交／恢复。
