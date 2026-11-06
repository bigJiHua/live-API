# AI 业务开放评估报表

评估日期：2026-11-06。范围：当前 `feat/deepseek-ai-test` 工作区实际挂载 API 与其业务实现；包含已有未提交改动。本报表为源码盘点与开放建议，不自动注册新模型工具，也不代表已经验证所有线上角色、数据库权限和历史数据。

## 1. 结论与开放顺序

目前模型开放 **4 个工具：3 个受控读取、1 个普通收支草稿生成**。项目实际挂载 **20 个模块、23 个路由组、183 个业务 HTTP 接口声明**。HTTP 接口数量不等于模型工具数量，也不等于可以安全开放的业务能力数量。

建议先增加预算查询、纯待办查询、普通周期计划查询、工资记录与估算查询；然后适配账户余额、信用卡债务/账期、资产快照、固定资产、基金和分期只读视图。日记与位置需要按具体请求提供最小数据。除已实现的普通人民币收支人工核对提交外，转账、还款、冲正、外币对账、分期入账、投资和系统管理继续使用人工业务入口。

最大的接入风险是 **现有 GET 带业务写副作用**。账户余额、空账单列表、资产首页、固定资产列表、分期列表、组合日历/提醒都会在某些条件下改库。AI 不能直接调用这些控制器；需要独立只读投影或明确无副作用的计算函数。

OCR 的合适边界是“用户本次上传图片 → 识别候选字段 → 聊天内可编辑草稿 → 用户核对 → 现有受控提交”。支付截图、银行账单和银行卡还款必须先区分业务类型，识别成功不能直接视作可以入账。

## 2. 统计口径与业务地图

统计依据：[API 总挂载入口](../app.js:222)、[模块路由挂载](../src/api/index.js:34)。

- 使用 `@babel/parser` 解析当前源码，统计实际挂载路由内的 `router.get/post/put/patch/delete` 声明；不执行路由模块。
- 共 **GET 79、POST 56、PUT 26、PATCH 1、DELETE 21**，合计 183。
- 不计注释路由、自动 HEAD、CORS OPTIONS、静态文件、中间件；未解析动态路径为 0。
- `app.js` 另有 `GET /api/health` 与根路径 `GET/POST /share/diary/detail` 3 个外围显式处理器，未计入上述业务 183。
- 当前统计已包含本轮新增 `POST /api/v1/ai/ocr`；模型工具清单仍单独记录，OCR是应用上传识别入口，不是可由模型任意调用的图片/文件读取工具。
- 日记实际模块为 `/moment`，项目未挂载 `/diary`。
- 以下分类按业务能力与读写路径划分，同一模块可同时出现在多个开放等级中；不将模块按一个风险标签简单累加。

| 实际路由前缀 | HTTP 声明数 | 路由源码 |
|---|---:|---|
| `/auth` | 9 | [index.js](../src/modules/auth/api/index.js:1) |
| `/security` | 7 | [index.js](../src/modules/security/api/index.js:1) |
| `/account` | 15 | [index.js](../src/modules/account/api/index.js:1) |
| `/accountBalance` | 4 | [balance.js](../src/modules/account/api/balance.js:1) |
| `/category` | 5 | [index.js](../src/modules/category/api/index.js:1) |
| `/card/bill` | 12 | [bill.js](../src/modules/card/api/bill.js:1) |
| `/card/repay` | 6 | [repay.js](../src/modules/card/api/repay.js:1) |
| `/card` | 11 | [index.js](../src/modules/card/api/index.js:1) |
| `/user` | 4 | [index.js](../src/modules/user/api/index.js:1) |
| `/upload` | 6 | [index.js](../src/modules/upload/api/index.js:1) |
| `/moment` | 7 | [index.js](../src/modules/moment/api/index.js:1) |
| `/asset` | 7 | [index.js](../src/modules/asset/api/index.js:1) |
| `/todo` | 7 | [index.js](../src/modules/todo/api/index.js:1) |
| `/work` | 8 | [index.js](../src/modules/work/api/index.js:1) |
| `/fixedAsset` | 10 | [index.js](../src/modules/fixed_asset/api/index.js:1) |
| `/budget` | 6 | [index.js](../src/modules/budget/api/index.js:1) |
| `/flow` | 1 | [index.js](../src/modules/flow/api/index.js:1) |
| `/data-manager` | 16 | [index.js](../src/modules/dataManager/api/index.js:1) |
| `/fund` | 11 | [index.js](../src/modules/fund/api/index.js:1) |
| `/recurring` | 10 | [index.js](../src/modules/recurring/api/index.js:1) |
| `/geo` | 3 | [index.js](../src/modules/geo/api/index.js:1) |
| `/share` | 3 | [index.js](../src/modules/share/api/index.js:1) |
| `/ai` | 15 | [index.js](../src/modules/ai/api/index.js:1) |
| **合计** | **183** | **20 模块 / 23 路由组** |

## 3. 已开放能力与现有防线

| 模型工具 | 当前能力 | 数据源/最小字段 | 明确限制 |
|---|---|---|---|
| `query_finance_summary` | 本人指定日期收支、分类汇总 | `account` + 本人 `bus_category`；日期、收入/支出、数量、分类名称/方向/金额 | 最多93天；CNY口径；剔除转账、信用卡还款、删除和冲正流水；分类最多30组 |
| `query_transactions` | 本人指定日期分页流水 | 日期、收支方向、原金额/币种、CNY折算、分类、备注 | 每页最多20条，offset≤100；返回total/hasMore；当前页不能推断全量总额 |
| `list_record_choices` | 普通收支的分类与账户匹配 | `bus_category` id/name/type；`card_base` id/别名/type | 本人、未删除、账户正常；各最多100；过滤特殊分类；不返回完整卡号、银行账号、余额或密钥 |
| `propose_transaction` | 生成一笔普通人民币收支草稿 | 方向、金额、日期、分类/账户候选、支付方式、备注、缺失字段 | 不明确时填null；不猜ID；不正式入账；特殊账务走专门业务流程 |

实现依据：[工具白名单与参数](../src/modules/ai/service/tools.js:11)、[独立只读仓库](../src/modules/ai/service/readRepository.js:6)、[特殊分类政策](../src/modules/ai/service/draftPolicy.js:2)。

读取采用独立连接池、参数化固定 SELECT、`SET TRANSACTION READ ONLY`、绑定服务器鉴权得到的 userId、5秒查询超时、限流式连接/排队上限。源码要求独立 AI 数据库配置且不接受名为 root 的读取账户；**仍需在部署验收中确认该账户实际 GRANT 只有需要表的 SELECT 权限**，不能仅凭用户名宣称数据库权限已经达标。

草稿保存使用独立 `bus_ai_draft`；会话/消息也在 AI 独立业务表。人工修改会重置为待核对并增加版本，过期/取消/旧版本/重复提交拒绝。正式提交 API 只收草稿ID与版本；在同一事务中锁定、复验本人账户与分类、调用信用/借记业务模型、更新草稿和回执；模型工具没有正式提交函数。本轮OCR单笔合格识别生成 `source=image-ocr` 草稿，正式提交只额外接受该来源，仍要求真实读取环境及同一套人工核对、版本、归属和事务守卫。依据：[草稿状态](../src/modules/ai/service/drafts.js:65)、[人工提交与原子事务](../src/modules/ai/service/index.js:245)。

草稿可暂存最多4位小数供核对，但正式人民币入账只接受有效精度到分，不能静默截断。信用卡只允许普通支出草稿，信用卡收入/还款不进入普通收支路径。转账、提现、购汇、结汇、还款、分期、冲正、退款、证券买卖和初始化余额不开放为普通草稿。

`/ai` 现有15个HTTP接口还包括设置、供应商余额、模型列表、聊天与历史、草稿动作等。其中 `GET /ai/balance` 是 **DeepSeek 供应商账户余额**，不是用户账本余额；不能据此回答“我银行卡里多少钱”。

## 4. 全模块开放评估

“可优先接只读”表示源业务已有读取基础，仍须新增明确参数/字段的工具适配和验收，并非将原始 HTTP 响应全部转给模型。“需业务适配”表示存在副作用、复杂金额或组合记录，应先拆解。写入项的风险按具体业务链路判断。

| 模块（声明数） | 实际业务与主要表/服务 | 评估等级与可开放能力 | 保留人工操作/关键风险 |
|---|---|---|---|
| auth (9) | 登录、刷新、握手、会话、登录日志；`user_info/device_crypto` | **高风险人工专用**；鉴权只在服务端提供当前userId | 不提供密码、JWT、AES Key、握手信息或认证管理工具 |
| security (7) | PIN、风险验证、重置、风险报告 | **高风险人工专用**；由应用完成安全挑战 | 模型不能自行解锁、验证PIN、读取安全凭证或改变锁定状态 |
| account (19) | 流水、转账、月统计、余额；`account/account_transfer/account_balance`，AccountSettlement | **已开放**普通收支查询/草稿；余额、转账视图**需适配** | 余额GET会重算/建快照；转账列表会配对补写；冲正、还款、余额初始化/重建人工专用 |
| category (5) | 收支分类/银行分类；`bus_category` | **已开放**普通分类最小候选；可优先扩分类释义 | 修改/删除分类会影响归类，不自动新建分类；特殊ID与名称保留 |
| card (29) | 卡片、共享额度池、账单、还款、外币登记；`card_base/card_credit_pool/card_bill/card_repay/card_foreign_register`，CreditCore | 账户别名候选**已开放**；债务/账期/还款历史**需适配** | 默认卡列表可能初始化；空账单会重建；还款、额度池分配、外币对账、账单重建人工专用 |
| user (4) | 资料、邮箱、密码；`user_info` | **高风险人工专用**；无需为了财务分析提供用户表 | 邮箱/密码/个人资料修改仍走现有验证，不开放模型账号管理 |
| upload (6) | 附件上传/检索/编辑/删除；`sys_attachment` + 文件 | **需业务适配**；OCR只处理用户本次选定图片 | GET列表/搜索生成缩略图；不让模型遍历所有附件；支付截图避免一般公开资源目录 |
| moment (7) | 日记主子记录；`moment` | **需业务适配与具体授权**；指定日期纯文本摘要 | 单条模型SQL仅id、控制器后验归属，AI须SQL同时绑定userId；分享密码/位置/图片URL不发送 |
| asset (7) | 流动资产快照、人工资产登记；`asset_snapshot/asset_register`，CreditCore | **需业务适配**；资产覆盖范围与历史变化查询 | 首页缺快照会创建，不能直接调用；人工登记不等于已到账；首页不含固定资产/基金 |
| todo (7) | 待办、组合月历/提醒；`todo`、周期计划、账单 | 纯待办**可优先接只读**；组合日历**需适配** | 月历/提醒装饰会写分期作废；派生事件不能当todo实体编辑；占位记录需剔除 |
| work (8) | 工作与日/月工资；`work_job/work_salary` | **可优先接只读**；薪酬记录、估算、月合计 | 工资计算不等于到账；保存日薪会补本月缺失记录；改离职日期会删工资，写入人工专用 |
| fixed_asset (10) | 购置、折旧、账面现值、回收站；`fixed_asset` | **需业务适配**；已保存账面值/折旧截至日期 | GET列表自动补提折旧并UPDATE；现值不是二手售价；折旧/恢复/永久删除人工专用 |
| budget (6) | 预算、登记使用额、执行状态；`budget` | **可优先接只读**；预算与登记剩余 | stats读取used_amount而非account真实消费；写入可改已用额，禁止自动当真实扣款 |
| flow (1) | 收支日历；`account` | **需业务适配**；按现有AI汇总口径另做每日序列 | 原接口直接SUM金额，混币且未剔除转账/还款/冲正，不能当CNY消费统计 |
| dataManager (16) | 表数据、导入导出、备份、SQL上传 | **高风险人工专用** | 即使GET也能全库导出；严禁提供任意SQL/表名/备份/导入/下载工具；所有路由需admin |
| fund (11) | 本金、市值、收益历史；`fund/bus_fund_history` | **需业务适配**；投资持仓与变化只读 | net_value存收益、market_val存本金变动；兼容旧快照公式；收益≠现金到账；买卖/历史修改人工专用 |
| recurring (10) | 固定周期计划/分期、期次状态；`bus_recurring` | 普通计划**可优先接只读**；分期**需适配** | GET installments会自动真实入账；月历装饰可作废期次；enter/abort/month-status人工专用 |
| geo (3) | 网络诊断、IP定位、逆地理编码；外部代理 | **按请求适配**；不是财务AI第一批必需工具 | 不默认发精确位置、IP、位置历史给模型；外部失败不导致账务变动 |
| share (3) | Token/密码分享公开查看；moment与分享校验 | **高风险人工专用** | 不把公开接口当用户隔离数据源；不发分享Token/密码；模型不创建或扩大分享权限 |
| ai (15) | 设置、模型/余额、聊天、草稿/历史 | **已开放**4个模型工具；新增OCR应用入口按草稿链路接入 | Key只在服务端使用，返回脱敏设置；上游401/403应为AI服务错误，不触发系统登出 |

数据管理权限依据：[requireAdmin与路由](../src/modules/dataManager/api/index.js:35)。附件归属依据：[SysAttachment用户绑定查询](../src/modules/upload/model/attachment.js:79)。各实际 HTTP 路径见附录，未以注释/README猜测接口。

## 5. 需要先隔离的 GET 副作用

| 实际读取入口 | 条件与副作用 | 精确源码 | AI接入要求 |
|---|---|---|---|
| `GET /card` | 默认Card.findAll初始化虚拟卡/银行分类；外部executor时当前代码跳过初始化 | [Card.findAll](../src/modules/card/model/index.js:92) | 自己查本人最小字段；不要走默认初始化 |
| `GET /accountBalance` | 清理失效快照、重算并UPDATE、初始化虚拟/储蓄卡快照 | [getList](../src/modules/account/controller/balanceController.js:31)、[verifyAndSync](../src/modules/account/controller/balanceController.js:114) | 从账本纯计算或读取明确时间的快照；缺失返回未初始化 |
| `GET /accountBalance/:cardId` | 快照缺失时计算并INSERT | [getByCardId](../src/modules/account/controller/balanceController.js:208) | 禁止自动补快照 |
| `GET /account/transfer/list` | 自动配对历史转账、UPDATE transfer_group_id、INSERT/恢复account_transfer | [findTransferList](../src/modules/account/model/index.js:215) | 只查询已存在配对；未配对记录标待处理 |
| `GET /card/bill` | 无账单时CreditCore.syncCardBills重算并写账单 | [getList](../src/modules/card/controller/billController.js:14) | 固定SELECT账单快照；需要实时值用独立纯计算 |
| `GET /asset/home` | 无快照时创建asset_snapshot；聚合还可能涉及默认卡初始化 | [getHomeAsset](../src/modules/asset/controller/index.js:21)、[getLatest](../src/modules/asset/model/snapshot.js:164) | 缺快照不补写；返回覆盖范围与来源 |
| `GET /fixedAsset/list` | 自动补提折旧，写累计折旧、账面值、截至日期等 | [list](../src/modules/fixed_asset/controller/index.js:21)、[depreciate](../src/modules/fixed_asset/model/fixed_asset.js:239) | 返回已保存值；计算今天估值只在内存，标估算 |
| `GET /recurring/installments` | autoEnterPending可能生成正式分期流水 | [installments](../src/modules/recurring/controller/index.js:77) | 单独读取计划/期次，不能触发自动入账 |
| `GET /todo/calendar/month`、`/todo/reminders` | 周期日历装饰调用voidExpiredInstallments，写期次作废 | [月历](../src/modules/todo/controller/index.js:100)、[提醒](../src/modules/todo/controller/index.js:257)、[decorateRowsForCalendar](../src/modules/recurring/model/index.js:507) | 构造纯日历投影；只展示推导状态不更新计划 |
| `GET /upload/list`、`/upload/search` | 为图片创建缩略图，写文件 | [list](../src/modules/upload/controller/index.js:685)、[search](../src/modules/upload/controller/index.js:757) | 读取最小附件元数据，OCR不用附件全列表 |

以上是实际挂载路径的审计发现，不是断言所有 GET 都会写。例：`recurring.decorateInstallmentStatus` 本身只读账单；`todo.getOverdueItems` 虽会 UPDATE，目前没有对应挂载路由，未计入接口风险清单。

## 6. 建议新增工具与最小字段

以下新增查询工具名称是设计建议，**尚未开放**；OCR应用入口已在本轮挂载。每个工具参数只允许明确日期/业务ID/有限枚举/分页；禁止模型提供userId、SQL、表名、任意字段表达式或文件系统路径。

| 顺序 | 建议工具 | 可参考现有HTTP读取 | 最小返回字段与服务来源 |
|---|---|---|---|
| 第一批 | `query_budget_summary` | GET /budget/list、/stats、/:id | 标题、类型、周期/日期、预算金额、登记使用额、剩余；budget；标“登记预算口径” |
| 第一批 | `query_todos` | GET /todo/list、/:id | 内容、日期、优先级、状态；todo纯SELECT；排除占位，限制正文长度 |
| 第一批 | `query_recurring_plans` | GET /recurring/list、/summary、/:id | 名称、所属月、日期、month_amount、完成/跳过、周期；bus_recurring；标“计划金额” |
| 第一批 | `query_salary_records` | GET /work/salary/day、/month | 日期、工作别名、净额、是否已保存/is_calculated、月合计；work_salary纯读与纯计算 |
| 第二批 | `query_account_balances` | accountBalance读取逻辑 | 账户别名/类型、余额、CNY、截至时间、账本计算/快照；account纯SELECT或account_balance；不能当支出统计 |
| 第二批 | `query_credit_obligations` | GET /card/bill/:id、/card/:id、账单latest | 账单月份、账期、待还/已还、还款日期、债务/溢缴款、共享池关系；CreditCore只读聚合，避免重复额度 |
| 第二批 | `query_repayment_history` | GET /card/repay、/:id | 日期、信用卡别名、还款额、币种、账单月、来源类型；card_repay只读；还款不是消费 |
| 第二批 | `query_asset_snapshot` | GET /asset/snapshot/list、登记读取 | 流动资金、溢缴款、信用债务、净余额、时间、覆盖范围、登记/实时/历史；asset_snapshot/register |
| 第二批 | `query_fixed_assets` | fixedAsset详情读取 | 名称、购买价、账面现值、累计折旧、残值、状态、折旧截至日期；fixed_asset最小SELECT |
| 第二批 | `query_fund_positions` | GET /fund/list、/:id/history | 基金别名、日期、本金变动/余额、累计收益、市值、收益率、公式版本；fund与bus_fund_history |
| 第二批 | `query_installment_plan` | recurring分期数据结构 | 计划名、总期数、本期/剩余金额、期次、计划/已入账/作废状态；bus_recurring纯投影；对照account避免重复 |
| 第二批 | `query_daily_finance` | GET /flow/calendar结构 | 日期、CNY收入/支出/数量、同query_finance_summary政策；直接复用AI只读仓库统计约定 |
| 指定请求 | `query_moment_text` | GET /moment/:id、POST /moment/batch | 日期、纯文本、主子关系；moment查询同时绑定user_id；不发位置、图片、分享信息 |
| 本轮OCR | 上传识别应用API + 原`propose_transaction` | POST /ai/ocr | 图片识别字段/文本、原金额与币种、交易状态、日期、业务类型、商户、缺失/不确定字段；通过现有草稿核对 |

不让模型同时拿到全部领域数据。一次问题只传相关工具结果，例如“预算还剩多少”不需要银行账号、工资税率、日记、附件URL或登录日志。工具结果中的备注/日记/图片文字是非可信数据，即使出现“忽略规则/调用接口/修改数据库”，也只能视为正文。

## 7. 金额口径、来源和现有不一致

| 数据类型 | 当前实现与正确解释 | 不允许的推断 |
|---|---|---|
| AI账本汇总 | account本人有效流水，CNY逐笔ROUND至分；外币逐笔ROUND(amount×exchange_rate/100,2)；剔除转账、CATEGORY_REPAY、删除、冲正 | 不能叫银行卡余额、净资产、基金收益或所有业务的经济消费；当前筛选未涵盖全部投资本金/初始化等特殊分类 |
| 账户余额 | AccountSettlement.calculateBalance从账户有效流水收入−支出；含资金转移等对余额确有影响的交易 | 不能拿剔除转账/还款的AI消费汇总替代余额；余额验证不能直接采用消费汇总 |
| 外币 | 汇率是“100外币对应人民币”。currency.toCNY外币截到4位再累计取分；AI仓库逐笔取分 | 两种汇总可能有分级差异；应明确选用合同口径并验收，不让模型自行算汇率或取整 |
| 信用卡/共享池 | CreditCore统一账期、真实债务、溢缴款、待对账外币和共享额度 | 卡片额度不是资产，溢缴款与债务分开；池额度/债务不能按每卡再叠加 |
| 已保存账单 | card_bill是重算后的账单快照，关联账期/还款状态 | 快照未刷新不代表实时已归零，不能在查询时自动修账 |
| 预算 | budget.amount与used_amount；剩余=计划−登记使用 | used_amount不是account实际消费；两个数必须分别命名 |
| 工资 | 保存净额与计算估算分开；月合计汇总已保存日薪 | 工资记录、预计月薪不代表已到账；不能再与account收入合并相加 |
| 固定周期/分期 | month_amount与期次是计划；done/skipped/pending不同；分期入账另有account流水 | 计划+已入账同时求和会重复，未执行计划不是实际支出 |
| 基金 | 当前本金=原本金+历史本金变动；收益=历史收益累计；市值=本金+收益，兼容旧快照 | 字段net_value不能直译单位净值，market_val不能直译市值；持仓收益不是现金到账 |
| 固定资产 | 购买价、残值、折旧和账面现值，月折旧=(购买价−残值)/月数 | 账面值不是售出价格或可用余额；购买流水与资产价值不能直接叠加当总资产 |
| 资产首页 | 现金类资金+信用卡溢缴款，再减信用债务；人工登记另有来源 | 当前首页不含固定资产/基金，不得宣称“我的所有资产” |
| 原flow日历 | 直接SUM(account.amount)，只限制用户/删除/日期 | 混币、资金转移/还款、冲正口径未对齐，不能将其原数答作人民币消费 |

实现依据：[AI统计政策](../src/modules/ai/service/readRepository.js:28)、[余额计算](../src/modules/account/service/settlement.js:17)、[货币工具](../src/common/utils/currency.js:6)、[CreditCore聚合](../src/modules/card/core/CreditCore.js:176)、[原日历](../src/modules/flow/api/index.js:23)、[预算stats](../src/modules/budget/model/budget.js:157)、[工资月汇总](../src/modules/work/model/salary.js:359)、[基金聚合](../src/modules/fund/model/index.js:30)、[资产范围](../src/modules/asset/model/snapshot.js:29)。

建议所有新工具返回 decimal字符串，不把金额先转换成浮点JSON数值再让模型累加；附 `currency`、`asOf`、`source`、`policy`、`isEstimated`、范围与截断标记。求和、汇率、月历与分期状态由服务端计算，模型只解释结果。缺数据/查询失败返回明确状态，不以0补齐。

## 8. OCR 已实现控制、实际验收与残余限制

本轮已挂载 `POST /api/v1/ai/ocr`。这是用户主动上传图片的应用入口，模型不能遍历附件、取外部URL或读取本机文件。预算、工资、资产等建议工具仍未注册。实施与测试记录见[当日合并日志·OCR 一节](CHANGELOG_2026-11-06.md)。

### 已落实的控制

1. **图片与传输边界**：沿用登录鉴权、AES、安全请求与PIN链路；OCR/chat共享每用户每分钟6次和同用户并发限制。仅OCR路径JSON限4MiB，单张dataURL编码限2MiB；接受静态JPEG/PNG/WebP，Sharp校验真实格式、24MP和单帧，去元数据、旋转重编码并缩至最长边2400。发送前要求图片外发单独同意，原图/处理图不保存到公开上传目录或聊天历史。
2. **供应商调用**：复用当前连接设置与Key；官方api.deepseek.com使用deepseek-flash视觉，其他兼容地址使用所选模型。固定JSON提示、不提供工具、60秒超时、禁止重定向；供应商401/403返回本地502，不触发系统退出。不记录原始错误、图片或Key。
3. **严格输出与确定性脱敏**：最多20条明细、10条warnings并标truncated；严格字段/日期/正金额/类型/正文上限。返回及落库前隐藏链接和长数字，对商户、备注、账户提示、分类及依据文本处理；日期/金额依据只接受有限格式。图片文字作为不可信数据，不可作为执行命令。
4. **普通草稿资格**：单笔、未截断、高置信、已完成、普通CNY、明确合法日期、到分金额才可生成pending。服务端交叉检查完整日期、金额、成功状态、性质、收支方向和正负符号，拒绝依据与归一化字段矛盾；金额证据含美元符号$时拒绝作为CNY普通草稿；商户/备注/性质/分类的常见中英文转账、还款、退款、分期、投资等正文阻止普通草稿。依据仍来自模型识别，检查只证明内部一致。
5. **账户、核对与正式写入**：OCR不接收模型账户/分类ID；分类仅在本人候选中精确匹配，账户始终为空，用户必须选择。缺字段禁止核对；image-ocr仅扩展草稿来源，正式提交仍要求核对、版本、有效期、本人归属、正常账户、普通分类、余额/额度与同一事务。OCR本身不写account。
6. **多笔与历史**：账单、多笔、特殊、未完成/不完整识别仅展示，不自动生成普通草稿或批量入账。结构化结果存在ai_message.meta且可恢复；续聊只注入前5条，标不可信、识别条数及截断。无新草稿OCR清空旧latest_draft_id，避免追问误指旧卡片。对pending/reviewed图片草稿继续聊天补账户/分类/金额等时，propose更新同一ID、增加版本、保留image-ocr来源及图片hash/原trace，修改后重新核对；提示另一笔交易开始新对话。
7. **同图顺序重传**：处理后图片SHA-256按本人查有效pending/reviewed草稿或committed回执，顺序重传恢复原卡片/回执并提示。正式同draft重复提交由事务状态与版本守卫拒绝。同图查询与保存没有跨实例全局唯一约束。
8. **草稿读取与历史依据**：GET草稿临时错误返回503及固定提示，不误报草稿过期；历史恢复查询trace与OCR结构结果，Web对同ID卡片更新和历史去重。

源码依据：[输出校验与脱敏](../src/modules/ai/service/ocr.js:37)、[图片处理](../src/modules/ai/service/ocr.js:58)、[OCR资格与草稿](../src/modules/ai/service/index.js:74)、[本人同图查询](../src/modules/ai/service/drafts.js:57)、[受限续聊](../src/modules/ai/service/conversations.js:45)、[无草稿指针更新](../src/modules/ai/service/conversations.js:83)、[续聊同草稿更新](../src/modules/ai/service/index.js:198)、[读取错误分类](../src/modules/ai/api/index.js:73)、[正式提交](../src/modules/ai/service/index.js:245)。

### 本轮实际验证

| 验证 | 已通过结果 | 适用范围 |
|---|---|---|
| API自动回归 | `npm run test:ai`，15套 **304/304**；图片校验、脱敏、无工具视觉、证据/方向/符号矛盾、特殊类型、同图、归属/同意/连接版本、历史/指针、美元证据矛盾、OCR续聊同ID/hash/版本、草稿读取503、image-ocr信用/借记事务与失败回滚 | 隔离替身与合成样例，不代表供应商真实识别准确率 |
| Web回归/构建 | `npm run test:ai` **24/24**，`npm run build` 成功 | 本轮图片预览/同意、识别与草稿交互、同ID更新与历史去重 |
| 真实DeepSeek + 真数据库 | [ai-real-ocr-acceptance.js](../tools/ai-real-ocr-acceptance.js) **14项通过**；单笔12.34/2026-11-06→pending且accountId=null；账单10/25/8.50共3条，43.50总额未当交易且无草稿；同图待核对/已入账复用、缺字段/未核对拒绝、实际模型续聊补账户保留同草稿ID及hash、人工补齐核对/正式入账/回执、同草稿重复拒绝 | 两张仓库非私人样图，真实视觉调用与正式业务模型；未评测真实用户支付截图准确率 |
| 真库验收回滚 | 提交在外层事务中验证；回滚后流水、余额、账单、卡片与AI三表计数及摘要和此前一致 | 本轮验收未留正式账务变动；用户指定的旧0.01流水保留 |
| 浏览器实际链路 | Cookie/AES上传两图通过；支付草稿账户待选且核对禁用；取消折叠原卡片、不追加消息；账单3条无草稿；刷新恢复已取消草稿/识别表，原图不留历史；338px布局金额、日期、状态完整可读 | 浏览器未点击正式入账；支付验收草稿已取消，识别结果保留查看 |

样图：[单笔支付](../tests/fixtures/ocr-payment.png)、[多笔账单](../tests/fixtures/ocr-statement.png)。真实供应商调用与隔离测试分开记录；两张样图不代表真实银行或支付截图分布。

### 当前残余限制

- **必须人工核对**：置信度、原文依据和类型来自模型，一组自洽的错误识别仍可能成为待核对候选。金额、币种、日期、状态、账户和分类均须与原图核对，系统不能证明现实交易真伪。
- **可见图像信息仍外发**：去元数据/输出脱敏不会遮挡原图可见姓名、卡号、订单等信息。用户同意发送后，当前供应商能够读取本次图片。
- **变图与其他渠道重复**：裁剪、修改、重编码造成处理后hash不同，同一支付可能产生新候选；取消/过期草稿、手动或其他渠道已记记录也不能靠有效同图查询全覆盖。不能只按金额/日期硬去重。
- **跨实例竞争**：防重覆盖顺序重传；跨实例同时miss/save没有数据库唯一约束，可能生成两份草稿，各自人工核对后可能重复入账。同一个draft的重复提交仍受事务守卫保护。
- **多笔账单仅展示**：最多20条并标截断，尚无逐行选择、批量核对或批量入账；账单总额、待还、最低还款不能作为普通交易明细。
- **准确率与供应商范围**：仅两张非私人样图真实识别已验收，未测真实用户支付截图、完整银行账单样本准确率、自定义供应商视觉或所有业务金额口径。本轮通过不构成整个金融系统全面安全结论。

## 9. 每批开放必须通过的验收

| 验收项 | 通过标准 |
|---|---|
| 用户隔离 | A不能通过ID、分类、账户、分页、JOIN或附件访问B；SQL和工具上下文都绑定服务端userId |
| 真正只读 | 空表、过期分期、缺快照、没有账单时查询前后所有相关业务表行数与update字段不变；不触发初始化/补写/折旧/自动入账 |
| 权限隔离 | 新读取账户只有必要表SELECT；禁止DDL/DML/多语句/任意表/文件权限；工具白名单拒绝未知函数 |
| 参数与预算 | 日期上限、条数、offset、正文长度、OCR大小/像素/图片数、连接/查询/供应商超时均有效，错误不拖住认证公共池 |
| 金额对齐 | 每个工具与其声明口径在CNY分边界、外币逐笔/累计、共享池、已冲正、还款、基金旧记录、工资估算等样例一致 |
| 来源区别 | 快照/实时/人工登记/计划/估算/真实流水、实体/派生清楚标注，不混加工资/投资/资产与account收入 |
| 失败与分页 | 空数据明确为空；查询失败不能变成0；分页/30分类截断不假装全量；上游Key401不被当登录401 |
| 草稿与正式账本 | 模型只有proposal；缺字段/取消/过期/旧版本/停用账户/特殊分类拒绝；用户核对后修改必需重核对 |
| 原子/并发 | 两次同草稿提交仅一笔；余额/额度校验在事务内；任何步骤失败全部回滚，回执可追溯正式流水ID |
| 隐私与注入 | 不返回password/PIN/JWT/Key/分享密码/完整账号/无关日记位置；图片/备注恶意指令不会扩大工具权限 |

已有普通收支读取、草稿及信用/借记原子提交具备相关防线。本轮OCR代码、前端、真实供应商/真库外层回滚和浏览器链路验收结果见第8章及联调日志；建议的新业务工具尚未开放，仍须针对副作用、用户隔离和金额口径逐项验收。本报表作者仅做源码只读盘点与文件更新，真实验收由主实施流程完成，未进行全业务数据或真实用户截图准确率评测。用户指定保留的既有0.01验收流水未删除。

## 附录：实际挂载 HTTP 接口清单

以下为上述源码快照的 183 条声明，行号指向路由注册处。该表不是模型开放白名单。

| 序号 | 方法 | 实际路径 | 最终处理器 | 源码 |
|---:|---|---|---|---|
| 1 | GET | `/api/v1/auth/handshake` | `authController.getHandshake` | [index.js](../src/modules/auth/api/index.js:17) |
| 2 | POST | `/api/v1/auth/login` | `authController.login` | [index.js](../src/modules/auth/api/index.js:20) |
| 3 | GET | `/api/v1/auth/check-admin` | `authController.checkAdmin` | [index.js](../src/modules/auth/api/index.js:30) |
| 4 | POST | `/api/v1/auth/admin-register` | `authController.adminRegister` | [index.js](../src/modules/auth/api/index.js:33) |
| 5 | POST | `/api/v1/auth/refresh` | `authController.refreshToken` | [index.js](../src/modules/auth/api/index.js:36) |
| 6 | POST | `/api/v1/auth/logout` | `authController.logout` | [index.js](../src/modules/auth/api/index.js:39) |
| 7 | GET | `/api/v1/auth/me` | `authController.getCurrentUser` | [index.js](../src/modules/auth/api/index.js:45) |
| 8 | POST | `/api/v1/auth/lock-system` | `authController.lockSystem` | [index.js](../src/modules/auth/api/index.js:48) |
| 9 | GET | `/api/v1/auth/login-logs` | `authController.getLoginLogs` | [index.js](../src/modules/auth/api/index.js:51) |
| 10 | GET | `/api/v1/security/pin/check` | `securityController.PinStatus` | [index.js](../src/modules/security/api/index.js:9) |
| 11 | POST | `/api/v1/security/pin/verify` | `securityController.verifyPin` | [index.js](../src/modules/security/api/index.js:11) |
| 12 | POST | `/api/v1/security/pin/route-verify` | `securityController.verifyRoutePin` | [index.js](../src/modules/security/api/index.js:19) |
| 13 | POST | `/api/v1/security/pin/set` | `securityController.setPin` | [index.js](../src/modules/security/api/index.js:27) |
| 14 | POST | `/api/v1/security/pin/change` | `securityController.changePin` | [index.js](../src/modules/security/api/index.js:35) |
| 15 | POST | `/api/v1/security/pin/reset` | `securityController.resetPin` | [index.js](../src/modules/security/api/index.js:43) |
| 16 | POST | `/api/v1/security/risk-report` | `securityController.riskReport` | [index.js](../src/modules/security/api/index.js:51) |
| 17 | GET | `/api/v1/account` | `accountController.getList` | [index.js](../src/modules/account/api/index.js:16) |
| 18 | GET | `/api/v1/account/list` | `accountController.getByCard` | [index.js](../src/modules/account/api/index.js:19) |
| 19 | GET | `/api/v1/account/transfer/list` | `accountController.getTransferList` | [index.js](../src/modules/account/api/index.js:22) |
| 20 | GET | `/api/v1/account/stats/month` | `accountController.getMonthStats` | [index.js](../src/modules/account/api/index.js:25) |
| 21 | GET | `/api/v1/account/stats/cards-flow` | `accountController.getCardsFlowStats` | [index.js](../src/modules/account/api/index.js:28) |
| 22 | GET | `/api/v1/account/:id` | `accountController.getById` | [index.js](../src/modules/account/api/index.js:31) |
| 23 | PATCH | `/api/v1/account/:id/remark` | `accountController.updateRemark` | [index.js](../src/modules/account/api/index.js:34) |
| 24 | POST | `/api/v1/account/debit` | `debitController.create` | [index.js](../src/modules/account/api/index.js:39) |
| 25 | PUT | `/api/v1/account/debit/:id` | `debitController.update` | [index.js](../src/modules/account/api/index.js:42) |
| 26 | POST | `/api/v1/account/debit/:id/reverse` | `debitController.reverseDebit` | [index.js](../src/modules/account/api/index.js:45) |
| 27 | POST | `/api/v1/account/debit/:id/reverse/transfer` | `debitController.reverseTransfer` | [index.js](../src/modules/account/api/index.js:48) |
| 28 | POST | `/api/v1/account/credit` | `creditController.create` | [index.js](../src/modules/account/api/index.js:53) |
| 29 | PUT | `/api/v1/account/credit/:id` | `creditController.update` | [index.js](../src/modules/account/api/index.js:56) |
| 30 | POST | `/api/v1/account/credit/:id/reverse/expense` | `creditController.reverseCreditExpense` | [index.js](../src/modules/account/api/index.js:59) |
| 31 | POST | `/api/v1/account/credit/:id/reverse/repay` | `creditController.reverseCreditRepay` | [index.js](../src/modules/account/api/index.js:62) |
| 32 | GET | `/api/v1/accountBalance` | `accountBalanceController.getList` | [balance.js](../src/modules/account/api/balance.js:12) |
| 33 | GET | `/api/v1/accountBalance/:cardId` | `accountBalanceController.getByCardId` | [balance.js](../src/modules/account/api/balance.js:15) |
| 34 | POST | `/api/v1/accountBalance/init-virtual` | `accountBalanceController.initVirtual` | [balance.js](../src/modules/account/api/balance.js:18) |
| 35 | POST | `/api/v1/accountBalance/rebuild` | `accountBalanceController.rebuild` | [balance.js](../src/modules/account/api/balance.js:21) |
| 36 | GET | `/api/v1/category` | `categoryController.getList` | [index.js](../src/modules/category/api/index.js:16) |
| 37 | GET | `/api/v1/category/:id` | `categoryController.getById` | [index.js](../src/modules/category/api/index.js:19) |
| 38 | POST | `/api/v1/category` | `categoryController.create` | [index.js](../src/modules/category/api/index.js:22) |
| 39 | PUT | `/api/v1/category/:id` | `categoryController.update` | [index.js](../src/modules/category/api/index.js:29) |
| 40 | DELETE | `/api/v1/category/:id` | `categoryController.delete` | [index.js](../src/modules/category/api/index.js:36) |
| 41 | GET | `/api/v1/card/bill` | `cardBillController.getList` | [bill.js](../src/modules/card/api/bill.js:16) |
| 42 | GET | `/api/v1/card/bill/card/:cardId/latest` | `cardBillController.getLatestByCardId` | [bill.js](../src/modules/card/api/bill.js:20) |
| 43 | POST | `/api/v1/card/bill/card/:cardId/rebuild` | `cardBillController.rebuild` | [bill.js](../src/modules/card/api/bill.js:23) |
| 44 | GET | `/api/v1/card/bill/foreign/pending` | `cardBillController.foreignPending` | [bill.js](../src/modules/card/api/bill.js:29) |
| 45 | GET | `/api/v1/card/bill/foreign/list` | `cardBillController.foreignList` | [bill.js](../src/modules/card/api/bill.js:31) |
| 46 | GET | `/api/v1/card/bill/foreign/history` | `cardBillController.foreignHistory` | [bill.js](../src/modules/card/api/bill.js:33) |
| 47 | POST | `/api/v1/card/bill/foreign/register` | `cardBillController.foreignRegister` | [bill.js](../src/modules/card/api/bill.js:35) |
| 48 | PUT | `/api/v1/card/bill/foreign/:id/reconcile` | `cardBillController.foreignReconcile` | [bill.js](../src/modules/card/api/bill.js:37) |
| 49 | DELETE | `/api/v1/card/bill/foreign/:id` | `cardBillController.foreignDelete` | [bill.js](../src/modules/card/api/bill.js:39) |
| 50 | GET | `/api/v1/card/bill/:id` | `cardBillController.getById` | [bill.js](../src/modules/card/api/bill.js:42) |
| 51 | PUT | `/api/v1/card/bill/:id` | `cardBillController.update` | [bill.js](../src/modules/card/api/bill.js:45) |
| 52 | DELETE | `/api/v1/card/bill/:id` | `cardBillController.delete` | [bill.js](../src/modules/card/api/bill.js:52) |
| 53 | GET | `/api/v1/card/repay` | `cardRepayController.getList` | [repay.js](../src/modules/card/api/repay.js:16) |
| 54 | POST | `/api/v1/card/repay/merge` | `cardRepayController.mergeRepay` | [repay.js](../src/modules/card/api/repay.js:19) |
| 55 | GET | `/api/v1/card/repay/:id` | `cardRepayController.getById` | [repay.js](../src/modules/card/api/repay.js:22) |
| 56 | POST | `/api/v1/card/repay` | `cardRepayController.create` | [repay.js](../src/modules/card/api/repay.js:25) |
| 57 | PUT | `/api/v1/card/repay/:id` | `cardRepayController.update` | [repay.js](../src/modules/card/api/repay.js:28) |
| 58 | DELETE | `/api/v1/card/repay/:id` | `cardRepayController.delete` | [repay.js](../src/modules/card/api/repay.js:31) |
| 59 | GET | `/api/v1/card` | `cardController.getList` | [index.js](../src/modules/card/api/index.js:16) |
| 60 | GET | `/api/v1/card/pool` | `cardController.listPools` | [index.js](../src/modules/card/api/index.js:19) |
| 61 | POST | `/api/v1/card/pool` | `cardController.createPool` | [index.js](../src/modules/card/api/index.js:20) |
| 62 | PUT | `/api/v1/card/pool/:id` | `cardController.updatePool` | [index.js](../src/modules/card/api/index.js:21) |
| 63 | DELETE | `/api/v1/card/pool/:id` | `cardController.deletePool` | [index.js](../src/modules/card/api/index.js:22) |
| 64 | POST | `/api/v1/card/pool/assign` | `cardController.assignCardPool` | [index.js](../src/modules/card/api/index.js:23) |
| 65 | GET | `/api/v1/card/:id` | `cardController.getById` | [index.js](../src/modules/card/api/index.js:26) |
| 66 | POST | `/api/v1/card` | `cardController.create` | [index.js](../src/modules/card/api/index.js:29) |
| 67 | PUT | `/api/v1/card/sort` | `cardController.updateSortBatch` | [index.js](../src/modules/card/api/index.js:32) |
| 68 | PUT | `/api/v1/card/:id` | `cardController.update` | [index.js](../src/modules/card/api/index.js:35) |
| 69 | DELETE | `/api/v1/card/:id` | `cardController.delete` | [index.js](../src/modules/card/api/index.js:38) |
| 70 | PUT | `/api/v1/user/profile` | `authController.updateProfile` | [index.js](../src/modules/user/api/index.js:14) |
| 71 | POST | `/api/v1/user/email/send-code` | `authController.sendEmailCode` | [index.js](../src/modules/user/api/index.js:21) |
| 72 | PUT | `/api/v1/user/email/change` | `authController.changeEmail` | [index.js](../src/modules/user/api/index.js:29) |
| 73 | PUT | `/api/v1/user/password/change` | `authController.changePasswordWithCode` | [index.js](../src/modules/user/api/index.js:36) |
| 74 | POST | `/api/v1/upload/single` | `uploadController.upload` | [index.js](../src/modules/upload/api/index.js:44) |
| 75 | POST | `/api/v1/upload/multiple` | `uploadController.uploadMultiple` | [index.js](../src/modules/upload/api/index.js:48) |
| 76 | GET | `/api/v1/upload/list` | `uploadController.list` | [index.js](../src/modules/upload/api/index.js:52) |
| 77 | GET | `/api/v1/upload/search` | `uploadController.search` | [index.js](../src/modules/upload/api/index.js:56) |
| 78 | POST | `/api/v1/upload/batch-delete` | `uploadController.batchDelete` | [index.js](../src/modules/upload/api/index.js:60) |
| 79 | POST | `/api/v1/upload/:id` | `uploadController.edit` | [index.js](../src/modules/upload/api/index.js:64) |
| 80 | POST | `/api/v1/moment` | `momentController.create` | [index.js](../src/modules/moment/api/index.js:12) |
| 81 | GET | `/api/v1/moment/list` | `momentController.list` | [index.js](../src/modules/moment/api/index.js:15) |
| 82 | GET | `/api/v1/moment/today` | `momentController.today` | [index.js](../src/modules/moment/api/index.js:18) |
| 83 | GET | `/api/v1/moment/:id` | `momentController.detail` | [index.js](../src/modules/moment/api/index.js:21) |
| 84 | POST | `/api/v1/moment/batch` | `momentController.batchDetail` | [index.js](../src/modules/moment/api/index.js:24) |
| 85 | PUT | `/api/v1/moment/:id` | `momentController.update` | [index.js](../src/modules/moment/api/index.js:27) |
| 86 | DELETE | `/api/v1/moment/:id` | `momentController.delete` | [index.js](../src/modules/moment/api/index.js:30) |
| 87 | GET | `/api/v1/asset/home` | `assetController.getHomeAsset` | [index.js](../src/modules/asset/api/index.js:13) |
| 88 | GET | `/api/v1/asset/snapshot/list` | `assetController.getSnapshots` | [index.js](../src/modules/asset/api/index.js:16) |
| 89 | GET | `/api/v1/asset/register/list` | `assetController.getRegisters` | [index.js](../src/modules/asset/api/index.js:21) |
| 90 | GET | `/api/v1/asset/register/:id` | `assetController.getRegisterById` | [index.js](../src/modules/asset/api/index.js:24) |
| 91 | POST | `/api/v1/asset/register` | `assetController.createRegister` | [index.js](../src/modules/asset/api/index.js:27) |
| 92 | PUT | `/api/v1/asset/register/:id` | `assetController.updateRegister` | [index.js](../src/modules/asset/api/index.js:30) |
| 93 | DELETE | `/api/v1/asset/register/:id` | `assetController.deleteRegister` | [index.js](../src/modules/asset/api/index.js:33) |
| 94 | POST | `/api/v1/todo` | `todoController.create` | [index.js](../src/modules/todo/api/index.js:14) |
| 95 | GET | `/api/v1/todo/list` | `todoController.list` | [index.js](../src/modules/todo/api/index.js:17) |
| 96 | GET | `/api/v1/todo/calendar/month` | `todoController.calendarMonth` | [index.js](../src/modules/todo/api/index.js:20) |
| 97 | GET | `/api/v1/todo/reminders` | `todoController.reminders` | [index.js](../src/modules/todo/api/index.js:23) |
| 98 | GET | `/api/v1/todo/:id` | `todoController.detail` | [index.js](../src/modules/todo/api/index.js:26) |
| 99 | PUT | `/api/v1/todo/:id` | `todoController.update` | [index.js](../src/modules/todo/api/index.js:29) |
| 100 | DELETE | `/api/v1/todo/:id` | `todoController.delete` | [index.js](../src/modules/todo/api/index.js:32) |
| 101 | GET | `/api/v1/work/job/list` | `workController.list` | [index.js](../src/modules/work/api/index.js:14) |
| 102 | POST | `/api/v1/work/job` | `workController.createJob` | [index.js](../src/modules/work/api/index.js:17) |
| 103 | PUT | `/api/v1/work/job/:id` | `workController.updateJob` | [index.js](../src/modules/work/api/index.js:20) |
| 104 | DELETE | `/api/v1/work/job/:id` | `workController.deleteJob` | [index.js](../src/modules/work/api/index.js:23) |
| 105 | GET | `/api/v1/work/salary/day` | `workController.getDaySalary` | [index.js](../src/modules/work/api/index.js:28) |
| 106 | POST | `/api/v1/work/salary` | `workController.saveDaySalary` | [index.js](../src/modules/work/api/index.js:31) |
| 107 | GET | `/api/v1/work/salary/month` | `workController.getMonthSalary` | [index.js](../src/modules/work/api/index.js:34) |
| 108 | DELETE | `/api/v1/work/salary` | `workController.deleteDaySalary` | [index.js](../src/modules/work/api/index.js:37) |
| 109 | GET | `/api/v1/fixedAsset/list` | `fixedAssetController.list` | [index.js](../src/modules/fixed_asset/api/index.js:14) |
| 110 | GET | `/api/v1/fixedAsset/recycle-bin` | `fixedAssetController.recycleBin` | [index.js](../src/modules/fixed_asset/api/index.js:17) |
| 111 | GET | `/api/v1/fixedAsset/:id` | `fixedAssetController.getOne` | [index.js](../src/modules/fixed_asset/api/index.js:20) |
| 112 | POST | `/api/v1/fixedAsset` | `fixedAssetController.create` | [index.js](../src/modules/fixed_asset/api/index.js:23) |
| 113 | PUT | `/api/v1/fixedAsset/:id` | `fixedAssetController.update` | [index.js](../src/modules/fixed_asset/api/index.js:26) |
| 114 | PUT | `/api/v1/fixedAsset/:id/status` | `fixedAssetController.changeStatus` | [index.js](../src/modules/fixed_asset/api/index.js:29) |
| 115 | DELETE | `/api/v1/fixedAsset/:id` | `fixedAssetController.delete` | [index.js](../src/modules/fixed_asset/api/index.js:32) |
| 116 | PUT | `/api/v1/fixedAsset/restore/:id` | `fixedAssetController.restore` | [index.js](../src/modules/fixed_asset/api/index.js:35) |
| 117 | DELETE | `/api/v1/fixedAsset/permanent/:id` | `fixedAssetController.permanentDelete` | [index.js](../src/modules/fixed_asset/api/index.js:38) |
| 118 | POST | `/api/v1/fixedAsset/depreciate` | `fixedAssetController.depreciate` | [index.js](../src/modules/fixed_asset/api/index.js:41) |
| 119 | GET | `/api/v1/budget/list` | `budgetController.list` | [index.js](../src/modules/budget/api/index.js:16) |
| 120 | GET | `/api/v1/budget/stats` | `budgetController.stats` | [index.js](../src/modules/budget/api/index.js:19) |
| 121 | GET | `/api/v1/budget/:id` | `budgetController.getOne` | [index.js](../src/modules/budget/api/index.js:22) |
| 122 | POST | `/api/v1/budget` | `budgetController.create` | [index.js](../src/modules/budget/api/index.js:25) |
| 123 | PUT | `/api/v1/budget/:id` | `budgetController.update` | [index.js](../src/modules/budget/api/index.js:28) |
| 124 | DELETE | `/api/v1/budget/:id` | `budgetController.delete` | [index.js](../src/modules/budget/api/index.js:31) |
| 125 | GET | `/api/v1/flow/calendar` | `ArrowFunctionExpression` | [index.js](../src/modules/flow/api/index.js:8) |
| 126 | GET | `/api/v1/data-manager/tables` | `DataManagerController.getTableList` | [index.js](../src/modules/dataManager/api/index.js:37) |
| 127 | GET | `/api/v1/data-manager/status` | `DataManagerController.getTableStatus` | [index.js](../src/modules/dataManager/api/index.js:39) |
| 128 | GET | `/api/v1/data-manager/structure/:tableName` | `DataManagerController.getTableStructure` | [index.js](../src/modules/dataManager/api/index.js:41) |
| 129 | GET | `/api/v1/data-manager/data/:tableName` | `DataManagerController.getTableData` | [index.js](../src/modules/dataManager/api/index.js:43) |
| 130 | GET | `/api/v1/data-manager/export/table/:tableName` | `DataManagerController.exportSingleTable` | [index.js](../src/modules/dataManager/api/index.js:45) |
| 131 | GET | `/api/v1/data-manager/export/full` | `DataManagerController.exportFullDatabase` | [index.js](../src/modules/dataManager/api/index.js:47) |
| 132 | POST | `/api/v1/data-manager/validate` | `DataManagerController.validateImportData` | [index.js](../src/modules/dataManager/api/index.js:49) |
| 133 | POST | `/api/v1/data-manager/import` | `DataManagerController.importData` | [index.js](../src/modules/dataManager/api/index.js:51) |
| 134 | POST | `/api/v1/data-manager/import/sql` | `DataManagerController.importSql` | [index.js](../src/modules/dataManager/api/index.js:53) |
| 135 | GET | `/api/v1/data-manager/backups` | `DataManagerController.getBackupList` | [index.js](../src/modules/dataManager/api/index.js:55) |
| 136 | POST | `/api/v1/data-manager/backups/system` | `DataManagerController.createSystemBackup` | [index.js](../src/modules/dataManager/api/index.js:57) |
| 137 | GET | `/api/v1/data-manager/backups/system` | `DataManagerController.getSystemBackups` | [index.js](../src/modules/dataManager/api/index.js:59) |
| 138 | DELETE | `/api/v1/data-manager/backups/:filename` | `DataManagerController.deleteBackup` | [index.js](../src/modules/dataManager/api/index.js:61) |
| 139 | GET | `/api/v1/data-manager/download/:filename` | `DataManagerController.downloadBackup` | [index.js](../src/modules/dataManager/api/index.js:63) |
| 140 | GET | `/api/v1/data-manager/export/task/:taskId` | `DataManagerController.getExportTaskStatus` | [index.js](../src/modules/dataManager/api/index.js:65) |
| 141 | DELETE | `/api/v1/data-manager/export/task/:taskId` | `DataManagerController.cancelExportTask` | [index.js](../src/modules/dataManager/api/index.js:67) |
| 142 | GET | `/api/v1/fund/list` | `ctrl.getList` | [index.js](../src/modules/fund/api/index.js:9) |
| 143 | GET | `/api/v1/fund/history/all` | `ctrl.getAllHistory` | [index.js](../src/modules/fund/api/index.js:10) |
| 144 | GET | `/api/v1/fund/:id` | `ctrl.getById` | [index.js](../src/modules/fund/api/index.js:11) |
| 145 | POST | `/api/v1/fund` | `ctrl.create` | [index.js](../src/modules/fund/api/index.js:12) |
| 146 | PUT | `/api/v1/fund/:id` | `ctrl.update` | [index.js](../src/modules/fund/api/index.js:13) |
| 147 | DELETE | `/api/v1/fund/:id` | `ctrl.delete` | [index.js](../src/modules/fund/api/index.js:14) |
| 148 | GET | `/api/v1/fund/:id/history/monthly` | `ctrl.getMonthlyHistory` | [index.js](../src/modules/fund/api/index.js:15) |
| 149 | GET | `/api/v1/fund/:id/history` | `ctrl.getHistory` | [index.js](../src/modules/fund/api/index.js:16) |
| 150 | POST | `/api/v1/fund/:id/history` | `ctrl.addHistory` | [index.js](../src/modules/fund/api/index.js:17) |
| 151 | PUT | `/api/v1/fund/history/:id` | `ctrl.updateHistory` | [index.js](../src/modules/fund/api/index.js:18) |
| 152 | DELETE | `/api/v1/fund/history/:id` | `ctrl.deleteHistory` | [index.js](../src/modules/fund/api/index.js:19) |
| 153 | GET | `/api/v1/recurring/list` | `recurringController.list` | [index.js](../src/modules/recurring/api/index.js:9) |
| 154 | GET | `/api/v1/recurring/installments` | `recurringController.installments` | [index.js](../src/modules/recurring/api/index.js:10) |
| 155 | GET | `/api/v1/recurring/summary` | `recurringController.summary` | [index.js](../src/modules/recurring/api/index.js:11) |
| 156 | GET | `/api/v1/recurring/:id` | `recurringController.detail` | [index.js](../src/modules/recurring/api/index.js:12) |
| 157 | POST | `/api/v1/recurring` | `recurringController.create` | [index.js](../src/modules/recurring/api/index.js:13) |
| 158 | PUT | `/api/v1/recurring/:id` | `recurringController.update` | [index.js](../src/modules/recurring/api/index.js:14) |
| 159 | PUT | `/api/v1/recurring/:id/month-status` | `recurringController.updateMonthStatus` | [index.js](../src/modules/recurring/api/index.js:15) |
| 160 | POST | `/api/v1/recurring/:id/enter` | `recurringController.enterInstallment` | [index.js](../src/modules/recurring/api/index.js:17) |
| 161 | POST | `/api/v1/recurring/:id/abort` | `recurringController.abortInstallment` | [index.js](../src/modules/recurring/api/index.js:19) |
| 162 | DELETE | `/api/v1/recurring/:id` | `recurringController.delete` | [index.js](../src/modules/recurring/api/index.js:20) |
| 163 | GET | `/api/v1/geo/network` | `ctrl.getNetworkInfo` | [index.js](../src/modules/geo/api/index.js:19) |
| 164 | GET | `/api/v1/geo/ip` | `ctrl.getIpLocation` | [index.js](../src/modules/geo/api/index.js:22) |
| 165 | GET | `/api/v1/geo/regeo` | `ctrl.getReverseGeocode` | [index.js](../src/modules/geo/api/index.js:23) |
| 166 | GET | `/api/v1/share/diary/detail` | `sharePage.view` | [index.js](../src/modules/share/api/index.js:9) |
| 167 | GET | `/api/v1/share/:token` | `shareController.viewShare` | [index.js](../src/modules/share/api/index.js:10) |
| 168 | POST | `/api/v1/share/password` | `shareController.verifyPassword` | [index.js](../src/modules/share/api/index.js:11) |
| 169 | GET | `/api/v1/ai/balance` | `ArrowFunctionExpression` | [index.js](../src/modules/ai/api/index.js:16) |
| 170 | GET | `/api/v1/ai/capabilities` | `ArrowFunctionExpression` | [index.js](../src/modules/ai/api/index.js:31) |
| 171 | GET | `/api/v1/ai/settings` | `ArrowFunctionExpression` | [index.js](../src/modules/ai/api/index.js:32) |
| 172 | PUT | `/api/v1/ai/settings` | `CallExpression` | [index.js](../src/modules/ai/api/index.js:49) |
| 173 | DELETE | `/api/v1/ai/settings` | `CallExpression` | [index.js](../src/modules/ai/api/index.js:50) |
| 174 | POST | `/api/v1/ai/chat` | `CallExpression` | [index.js](../src/modules/ai/api/index.js:71) |
| 175 | POST | `/api/v1/ai/ocr` | `CallExpression` | [index.js](../src/modules/ai/api/index.js:72) |
| 176 | GET | `/api/v1/ai/drafts/:id` | `ArrowFunctionExpression` | [index.js](../src/modules/ai/api/index.js:73) |
| 177 | PUT | `/api/v1/ai/drafts/:id` | `CallExpression` | [index.js](../src/modules/ai/api/index.js:97) |
| 178 | POST | `/api/v1/ai/drafts/:id/action` | `CallExpression` | [index.js](../src/modules/ai/api/index.js:98) |
| 179 | GET | `/api/v1/ai/conversations` | `ArrowFunctionExpression` | [index.js](../src/modules/ai/api/index.js:101) |
| 180 | GET | `/api/v1/ai/conversations/:id/messages` | `ArrowFunctionExpression` | [index.js](../src/modules/ai/api/index.js:108) |
| 181 | DELETE | `/api/v1/ai/conversations/:id` | `ArrowFunctionExpression` | [index.js](../src/modules/ai/api/index.js:115) |
| 182 | POST | `/api/v1/ai/models` | `ArrowFunctionExpression` | [index.js](../src/modules/ai/api/index.js:123) |
| 183 | POST | `/api/v1/ai/drafts/:id/commit` | `CallExpression` | [index.js](../src/modules/ai/api/index.js:139) |

