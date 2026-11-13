# AI 财务与生活助手（契约 v1/v2）

> **2026-11-11 归档补注**：本文描述当时的 V1/V2 实现与验收。旧验收工具已移至 [脚本归档](../../../../temp/ai-v1-v2-cleanup-20261111/archive/scripts/README.md) 并移除 npm 入口；下文历史命令和计数仅作溯源，当前生产能力及测试兼容以 [V3 README](./README.md) 和源码为准。旧入口退役位置现为 `api/src/modules/ai/api/index.js`，下文旧行号保留原记录。

> **历史留档｜2026-11-07 标注：本文全部聊天类端点已停用。** `POST /chat`、`POST /ocr`、`/v2/*` 一律返回 `410 AI_VERSION_RETIRED`（`api/index.js:48-52`）；当前实现见 [V3 README](./README.md) 与 [V3 计划](../../../../Docs/docs/ai/PLAN/v3/README.md)。例外：`POST /v3/ocr` 仍调用本文所述的 v1 `runOcr` 作为独立固定提取链路（`contractVersion:1`），不属于 V3 编排。

API 与 Web 均使用 `feat/ai-assistant`。运行连接真实只读账本与 DeepSeek；模拟仓库/供应商仅用于明确隔离的自动测试。v1普通记账/OCR保留，v2新增范围预览、生活业务提案、聊天数据表/图和每日默认会话。实现与边界见[AI业务实施日志](../../../logs/CHANGELOG_2026-11-06_AI_BUSINESS_IMPLEMENTATION.md)、[资金预处理实施日志](../../../logs/CHANGELOG_2026-11-06_AI_FINANCIAL_PREPROCESSING.md)和[PLAN台账](../../../../Docs/docs/ai/PLAN/task-tracker.md)。当前未提交/部署；受控桌面UI已验收，完整66场景尚未全部验收。

本轮业务统计与开放顺序见 [业务开放评估报表](../../../logs/AI_BUSINESS_OPENING_ASSESSMENT_2026-11-06.md)，图片识别实现与验收见 [当日合并日志·OCR 一节](../../../logs/CHANGELOG_2026-11-06.md)。

## 数据访问与入账边界

模型收到的只是工具定义与获准发送的结果，不持有数据库连接、数据库密码、登录令牌或 DeepSeek Key。模型选择工具名和参数后，API 使用静态映射执行固定参数化 SQL；用户身份由登录中间件提供，工具参数不能传入身份、SQL、任意接口地址或额外字段。

读取使用独立 `AI_DB_*` 连接池，每次启用 `SET TRANSACTION READ ONLY`，固定 SELECT 后回滚结束。数据库账号必须只有 SELECT 权限；代码拒绝 root，但实际权限还须通过 `SHOW GRANTS` 验证。SELECT 权限不能隔离用户，所有业务读取仍绑定当前 `user_id`。

v1兼容聊天工具为 `query_finance_summary`、`query_transactions`、`list_record_choices`、`propose_transaction`，最后一个只生成草稿。v2不提供模型工具：服务器先准备获准业务快照，一次调用取得JSON答复/最多一个提案。两个版本都不给模型数据库连接或正式执行接口。

v2读取支持 `finance/account/card/budget/todo/work/asset/fixedAsset/fund/installment`，全部本人固定SELECT及纯计算；空domains用于闲聊/日记，不默认查财务。金额为decimal字符串，CNY至分、外币原值与基金收益四位；缺汇率/快照明确不完整/空值。已补预算香港/一日游固定LIKE、逐卡/月CNY消费/计数/登记到期月份/配置还款日，以及type+currency余额组成。信用账单/余额/固定资产是保存快照，工资为登记/估算，预算/分期为计划，不补写、作废、折旧或还款。手工/系统资产总额无currency证据，标unverified，同日差额为空不推导CNY。

外发只用随机128bit引用；真实ID不进入v2 snapshot、旧v1工具/历史/最近草稿或模型参数。v2预览/map加密存档，15分钟、≤64KiB、每dataset≤100行、范围≤12个月。digest绑定服务端归属、scope/指纹/连接/会话/原话/refMap；候选和4条500字用户原话都在同包预览，未知UUID/旧ref/sk-key隐藏。未消费preview可服务器撤销，审批/外发/引用/消费CAS拒绝撤销竞态；已发不能撤回。过期payload/refMap本人有界100行清理，保留id/digest/批准/request证据；换连接/跨用户/类型/过期拒绝，无真实ID回退。

新增人工业务提案为预算创建、todo创建/修改/完成/删除、私有日记、card alias/status、固定资产名称/品类与可分离回收/恢复/永久删除、基金明确日收益批量、管理员固定备份。每种有独立字段白名单与执行器；修改后重新核对，执行只收id/version，权限/目标快照重新复验，业务写入和回执同事务。**fixedAsset.create只预填，当前原建设中入口尚不能完成新增，禁止AI正式创建或初始化折旧。** 系统备份实际文件/重启验收未执行，不把queued回执说成备份完成。

实际还款、转账、冲正、退款、外币对账、分期入账、余额重建、正式折旧/精密重算，以及认证/私密资料/位置/分享/分类写入均不开放。基金只登记用户逐条明确日值，单基金≤31条、允许负收益、最多四位、既有日期整批拒绝；不推算收益、本金或汇率。

人工入账由 `POST /drafts/:id/commit` 单独触发，只接受版本号，业务字段全部取自库存档草稿。要求本人草稿、真实数据来源、未过期、已核对且版本一致。在同一事务内占用草稿、锁定并复验分类/正常账户、调用既有信用/借记写模型、保存流水号和回执，最后提交。异常回滚整组写入；已入账的同一草稿返回原回执，不重复写。请求结果不明时先读取草稿或流水，不能凭聊天文字判断入账成功。

`formalWriteEnabled=false` 沿用契约 v1，表示聊天工具没有直接写入能力；当前版本已有上述人工确认接口。前端通过草稿 `status=reviewed` 展示“去入账”并再次确认，不能把该标志理解成整个 API 没有正式写接口。

草稿仅支持一笔普通人民币收支，金额正式入账精确到分，不默默舍入更细的小数。账户、分类、方向、日期、支付方式均需校验。转账、提现、购汇/结汇、还款、分期、冲正、退款、证券买卖和初始化余额等特殊分类在候选、草稿与提交三个入口统一拒绝，应使用原有专门流程。模型无法唯一确认的账户留空，由用户选择。人工核对仍是必要步骤，系统无法证明模型提取的金额就是现实交易金额。

## 接口

前缀 `/api/v1/ai`，沿用正式鉴权、安全请求头、AES 信封和 PIN 中间件，没有测试鉴权白名单；响应 `Cache-Control: no-store`。Web 请求层将业务体包装为现有加密信封。

| 方法 | 路径 | 用途 |
|---|---|---|
| GET | `/capabilities` | 契约、模式、数据源和外发同意要求 |
| POST | `/chat` | `{message, scene:"chat", consent, conversationId?, connectionId?}` |
| POST | `/ocr` | `{image:{dataUrl}, message?, consent, conversationId?, connectionId?}`，单张图片识别 |
| GET | `/drafts/:id` | 本人的草稿或已入账回执 |
| PUT | `/drafts/:id` | `{version, fields}`，修改后重置为待核对 |
| POST | `/drafts/:id/action` | `{version, action:"review"或"discard"}`，核对/取消不入账 |
| POST | `/drafts/:id/commit` | `{version}`，人工确认正式入账 |
| GET | `/conversations` | 本人的历史列表 |
| GET | `/conversations/:id/messages` | 本人的历史消息 |
| DELETE | `/conversations/:id` | 删除本人对话，不删除正式流水 |
| GET / PUT / DELETE | `/settings` | D-028 连接设置持久化（ai_provider_setting）：Key 加密落库、跟账号走多端共享、重启不丢；GET 只回 sha256 前16位 Key 指纹不回 Key；改 Key 重配轮换 connectionId；DELETE 删行回落 env 全局 Key |
| POST | `/models` | 获取当前连接或明确指定供应商的模型列表 |
| GET | `/balance` | DeepSeek 供应商额度，区别于账本余额 |

v2沿用同一前缀和正式鉴权、AES/PIN流程：

| 方法 | 路径 | 用途 |
|---|---|---|
| POST | `/v2/preview` | `{message,scope:{domains,startDate?,endDate?},conversationId?}`，纯读并返回授权数据预览，未发AI |
| DELETE | `/v2/previews/:id` | 撤销本人的未消费预览；撤销后不可批准/外发/反解ref，已消费返回409 |
| POST | `/v2/chat` | `{requestId,previewId,consent:true}`，单次消费该预览，最多1次provider |
| POST | `/v2/transaction/preflight` | 原话或白名单fields，核对金额/账户/来源和资金风险，0次provider |
| POST | `/v2/transaction/draft` | 必填UUID requestId；补齐字段且预检允许后创建本人pending草稿，0次provider |
| GET / DELETE | `/v2/transaction/candidates/:id` | 读取或取消本人的非执行候选；已消费展示原草稿，不生成第二份 |
| GET | `/v2/requests/:requestId` | 仅读本人的运行/成功/失败回执，禁止自动重新发chat |
| GET / POST | `/v2/session` | 当天default或显式manual会话，默认会话按本人/Shanghai日期唯一 |
| GET / PUT / DELETE | `/grant` | D-027 数据授权白名单（`ai_data_grant`，跟账号走）；preview/chat 双重门控：有域请求必须在白名单内，域外 403 `AI_GRANT_REQUIRED`/`AI_DOMAIN_NOT_GRANTED`(missingDomains)；纯闲聊不拦；撤回置revoked_at保留审计 |
| GET / PUT | `/v2/proposals/:id` | 读取、编辑本人类型提案，编辑后重置待核对 |
| POST | `/v2/proposals/:id/action` | `{version,action:'review'|'discard'}`，核对或取消 |
| POST | `/v2/proposals/:id/execute` | `{version}`，人工执行已核对的存档版本或读幂等回执 |

v2数据集是`{datasetId,domain,title,columns:[{key,label,type}],rows,summary,policy,asOf,isEstimated,truncated}`。聊天图只接受`{datasetId,type:'bar'|'line'|'pie',xKey,yKeys,title}`并绑定服务器已返回列与数据；不接受JS/HTML/URL或任意表达式。缺失与0分开，图表与表格同源，不由模型计算系列值。

`chat.data` 包含回答、conversationId、真实数据源、实际工具 trace 和草稿。聊天组件直接展示服务端工具结果作为查询依据；模型文字仅为解释。客户端不能上传模型 history/messages。

## 支付截图与账单识别

在聊天输入框左侧点图片按钮，选择一张 JPEG/PNG/WebP，预览并单独同意外发后发送。原文件限制 8MiB，浏览器压缩后 dataURL 不超过 2MiB。请求沿用 AES、Cookie、PIN 与安全请求头；只有 OCR 路径允许 4MiB JSON 信封。服务端再次验证编码、内容格式、单帧和 24MP 限额，去元数据并重编码，不接受外部 URL、本机路径、SVG 或 GIF。

官方 DeepSeek 连接使用支持视觉的 `deepseek-flash`，共用当前 Key；其他兼容供应商沿用选定模型，图像能力未实测。识别请求没有模型工具，超时 60 秒、禁止重定向，与普通聊天共享同用户并发及每分钟 6 次预算。

只有未截断、高置信、已完成的单笔普通人民币收支，且完整日期、到分金额、收支方向和符号与识别的日期/金额/状态/业务性质文本内部一致时，才生成 `source=image-ocr` 的非执行候选。分类仅使用本人候选的唯一精确名称；账户始终留空，由用户选择并本地核验资金后才能创建草稿。图片与附加文字金额/方向/合法日期冲突时清空冲突字段，必须用户手工补齐，保留冲突证据。图片自身缺年份/证据不完整、失败/退款/待付款、转账/还款/分期/投资等特殊交易，以及多笔账单只展示识别表。禁止来源不能靠覆盖字段洗成普通交易。账单最多20条，不支持批量入账。

草稿显示后不重复输出字段文字；识别原文依据折叠在卡片下。编辑、核对、取消和人工入账使用既有版本、归属、有效期与原子提交流程。结构化识别结果写入聊天 meta，可恢复最多前 5 条到模型上下文，并标记为不可信图片数据；原图和处理图仅留页面内存，不写公开上传目录或数据库。输出对长数字标识及链接做确定性脱敏；这不会遮挡外发图片中的可见个人信息，发送前应由用户裁剪或遮挡。

当前图片草稿尚未结束时，聊天补充账户或修正字段会更新同一草稿 ID/版本并保留图片来源；已核对的草稿经修改后需再次核对。要记录另一笔交易请开始新对话，避免替换当前图片草稿。实时与历史聊天对同一草稿只显示一张卡，查询依据和草稿暂时读取失败提示另行保留。

相同预处理图片重传先查本人持久来源指纹，复用候选/草稿或原回执；数据库本人+指纹唯一与消费CAS避免跨实例新增第二份草稿。取消/过期/失败保留墓碑，不能借新请求号复活同图或再次识别。该哈希不能识别裁剪/变图；相似日期/金额/账户只提示可能重复，不自动合并或删除。模型的置信度与原文依据均来自识别输出，内部交叉校验不能证明现实事实准确，必须人工核对。

## 持久化与限额

既有草稿/消息表升级为 [018_ai_persistence.sql](../../../mysql/migrations/018_ai_persistence.sql)；本轮新增 [019_consolidated_20261111.sql](../../../mysql/migrations/019_consolidated_20261111.sql)并同步完整源。019创建AI分析预览/类型提案/请求运行/用户lane/后台job基础结构与每日会话锚点，连续两次真实执行幂等，26非AI正式表数量/摘要不变。升级规则见 [MySQL说明](../../../mysql/README.md)；原020加密财务候选及本人请求/指纹唯一约束已并入同一019合并脚本，两次专项幂等且正式26表摘要不变。未运行旧账务迁移或清理历史测试流水。

- 草稿存于 `bus_ai_draft`，状态为 pending/reviewed/discarded/committed，编辑/核对/取消均检查版本。提案 15 分钟有效，编辑不延长有效期；已入账回执可在提案有效期后读取。
- 对话与消息存于 `ai_conversation` / `ai_message`。一轮的两条消息、最新草稿关联及更新时间同事务持久化后才返回；模型上下文只取最近 10 条服务端历史。历史列表最多 50 个、详情最多 200 条。现有策略在列表读取时清理 90 天未更新的对话，不清理正式账本。
- 临时 Key 仅在后端按用户隔离的内存存储，1 小时有效、最多 500 份，重启后需要重设。不写 `.env`、数据库或浏览器存储，不回传 Key。修改供应商地址时必须明确提供该连接的 Key，不能隐式把旧地址的 Key 发往新地址。
- v1查询最多93天、明细20条/偏移100、每轮最多4工具/4provider，相同工具参数摘要重复即停止。v2每轮最多1provider，OCR最多1provider；不自动重试、修复输出、tool循环或递归invoke。共用持久user lane，每分钟6次、跨进程并发互斥。
- `ai_request_run`先占用requestId/预算再外发，重复id返回原回执或拒绝，失败/过期id不再付费；只清理过期回执内容，保留防重放墓碑。preview单次CAS绑定requestId，换新编号也不能重发同预览。服务端超时abort，提案写入和append前复验预算；Web断线恢复仅读回执，不因挂载/历史/设置变化自动发AI。
- 本地草稿lane预算强制0，不消耗或重置付费每分钟6次配额，仍共用单用户互斥和本地30次入口限制。候选消费、草稿保存和加密恢复回执同事务；事务成功后历史/外层回执确认失败只恢复同一草稿。GET与重复POST均读取当前草稿版本/终态，取消、过期和入账后不能回放旧pending卡。
- 草稿操作每分钟30次，设置/模型列表合计5次，另沿用对应入口保护；设置仍为按用户内存Key，不以请求防重基础设施存储凭据。
- 只读连接池最多 2 个连接、等待队列 8 个，连接/查询超时 5 秒；模型请求 20 秒且禁止重定向，Web 聊天请求超时 120 秒。

## 配置与真实页面

默认 `AI_MODE=disabled`。真实运行需要 `.env.example` 中的 `AI_MODE=deepseek`、`DEEPSEEK_API_KEY`、`DEEPSEEK_MODEL` 与独立 `AI_DB_*`，人工入账沿用既有正式写连接。`AI_ALLOW_SESSION_SETTINGS=true` 才允许页面临时连接设置。

`AI_BUSINESS_ENABLED`控制v2；production默认关闭，新增`AI_BUSINESS_ACTIONS`默认空；本地开发默认安全清单。`AI_BUSINESS_DOMAINS`/`AI_BUSINESS_ACTIONS`支持逗号白名单，未知项失败；`AI_BUSINESS_ENABLED=false`关闭新入口，保留业务数据与回执。已检查18固定业务表SELECT及5敏感表权限拒绝，不授权database.*、写权限或认证/密钥表。`AI_FINANCIAL_ENABLED=false`可关闭财务新增，既有回执和取消保留；同进程读取/锁等待/模型晚到及提交前复验开关，关闭时回滚。部署/跨进程统一关闭演练尚未验收。

当前保留已有 OpenAI 兼容供应商地址能力：HTTPS 或明确本机 HTTP，拒绝 URL 内嵌凭据、查询参数、锚点与重定向。此次只对 DeepSeek 实际验收；其他供应商并未实测。自定义 HTTPS 地址尚不等同于完整 SSRF 防护；若部署为允许不可信用户填写地址的服务，还需要网络出口隔离或管理员维护的地址允许列表。

普通运行的 `AI_MODE=mock` 或 `AI_SYNTHETIC_DATA=true` 会停止服务，不能静默降级成模拟数据。旧 `ai:sandbox` 脚本已移除。

```powershell
# D:\Code\live\api：沿用 .env，真实路由与鉴权；只绑定本机
npm run ai:real:server
# 默认端口来自 PORT，未设置时为 7788
# require(app) 不执行 app.js 的启动迁移与定时账务任务；这仍是具有正式写能力的真实 API。

# D:\Code\live\web：API 地址应指向上述服务
npm run dev -- --host 127.0.0.1 --port 5173 --strictPort
```

本轮联调页面保留在 `http://127.0.0.1:5174/ai`，固定指向本机7789 API；待办卡编辑/核对/取消、支付/账单OCR、刷新恢复已完成真实UI验收。登录后需同意把对话和必要查询结果发送至 DeepSeek。外发数据限于相关汇总/明细/备注、账户分类候选与短期上下文；候选账户不含卡号、BIN、密码或令牌。该同意按每轮 API 检查，未同意不会调用模型或工具。

消费汇总口径：排除标记“转账”的流水、信用卡还款、已删除及冲正记录；外币按每笔汇率的每 100 外币口径折算人民币并逐笔舍入到分。分页不能代表全量。本轮验证区间与页面一致，尚未证明全部历史、多币种银行对账或所有资产/负债报表一致。

## 验证

```powershell
# API AI自动回归：当前33套732项，fixture仅用于协议/错误分支
npm run test:ai
# 资金源测试不包含在test:ai文件名范围内，3套34项
npx jest tests/unit/financialPreflight.test.js tests/unit/financialPreflightCreditCore.test.js tests/unit/financialPreflightRead.test.js --runInBand
# v2只读/预览/匿名外发：3套39项为上述最终总数的子集
npx jest tests/unit/aiBusinessRead.test.js tests/unit/aiAnalysisPreviews.test.js tests/unit/aiEgressPolicy.test.js --runInBand
# 业务/防循环/编排/意图隔离测试
npx jest tests/unit/aiBusinessActions.test.js tests/unit/aiRequestGuard.test.js tests/unit/aiBusinessService.test.js tests/unit/aiBusinessIntent.test.js --runInBand
# 真库权限、日期、汇总/明细与身份隔离：只读检查
npm run ai:real:verify
# 真 DeepSeek + 真 SQL + 正式写模型：外层事务内执行，最终全部回滚
npm run ai:real:acceptance
# 真 DeepSeek 视觉 + 真库 OCR/核对/提交验收：同样全部回滚
npm run ai:real:ocr

# Web
npm run test:ai
npm run build
```

真实验收脚本不加载 app.js、不运行迁移/定时任务。写验收通过外层事务和 savepoint 包裹实际草稿、消息、现金/借记/信用写模型，最后比较正式流水、余额、账单、卡片与 AI 表的数量/摘要，确认回滚。它验证真实服务实现与数据库；浏览器另行验证正式 HTTP、登录 Cookie、加密请求和聊天组件。不能把任一单项检查当作整个金融系统的全面安全证明。

S-005上一阶段冻结的自动回归（以下三段和旧UI证据均保留原时点）：[API AI](../../../logs/ai-business-evidence/api-ai-tests.json)25套469项/[金额](../../../logs/ai-business-evidence/api-money-tests.json)8套160项，Web AI43项/金额6项均0失败，Web build退出0；早期3套39项为其中子集，不重复相加。两端差异检查通过，原报告冻结SHA未变。

v2[最终真SQL结果](../../../logs/ai-business-evidence/real-database.json)通过十域22数据集（卡6/资产4）本人/不存在用户隔离、preview撤销/审批外发ref拒绝/消费CAS0，以及安全动作/guard外层回滚；26非AI/35全库表行数/SHA不变，旧支出保留，provider=0、backup=0。重启遗留queued/running job转failed不重跑已测，实际文件未测。单连接savepoint另于[双物理pool](../../../logs/ai-business-evidence/physical-concurrency.json)验证跨真实连接409/429、防重放/6次预算/失败超时墓碑，9项通过、fixture exact清理残留0、26正式表不变、externalProvider0。

最终`tools/ai-business-provider-acceptance.js`7检查通过：查询/待办/39.91草稿3次真实调用，每轮1次，重复编号/预览无额外调用，AI外层回滚/账本不变；早期权限不足失败前已有财务query调用，不将这些失败运行写成0次。

[真实UI验收](../../../logs/ai-business-evidence/ui-acceptance.json)17项通过：待办日期11-07/修改/核对/取消；非私密支付图12.34/日期/交通/微信，缺账户不能核对且已取消；statement3行10.00/25.00/8.50，仅表无批量草稿、43.50合计排除。完成后DOM图引用0、回执无图片字节，刷新恢复default/取消态/识别表和输入。[实际计数](../../../logs/ai-business-evidence/ui-request-counts.json)证明本轮三个UI请求各provider_calls1/max1，刷新3→3、0新请求/0新provider、正式流水/todo写入0；这是本轮UI次数，与前述脚本/早期失败运行分开统计。

固定资产AI正式创建按R-024取消只提供安全预填，原产品创建/图片缺口另记。实际备份文件、正式业务UI执行/未覆盖交互/手机/跨天、生产部署与关闭演练未验收；非私密验收图不保证任意个人截图准确。当前源码与证据SHA见[独立实施清单](../../../../Docs/docs/ai/PLAN/sources/implementation-manifest-2026-11-06.json)，不冒充实现commit或发布记录。

S-008阶段最终回归：[AI](../../../logs/ai-business-evidence/s2-api-tests.json)33套732项、[资金源](../../../logs/ai-business-evidence/s2-funds-final-tests.json)3套34项、[金额](../../../logs/ai-business-evidence/s2-money-tests.json)8套176项均通过；金额与AI有重叠，不相加。Web64项/金额6项和构建通过。[本轮真实页面](../../../logs/ai-business-evidence/s2-ui-acceptance.json)10项通过，provider增量0，正式26表摘要不变；普通39.91仅创建、核对、取消，未正式入账。[全场景证据](../../../../Docs/docs/ai/PLAN/next-stage/scenario-evidence.json)逐项保留缺测范围，[S2冻结清单](../../../../Docs/docs/ai/PLAN/sources/s2-implementation-manifest-2026-11-06.json)记录当前实现与证据，不覆盖上一阶段冻结文件。
