# 2026-11-06 变更日志（合并）

> 本文件合并 2026-11-06 当日六份日志：认证 401 排查、金额精度、AI 表迁移、AI 真实联调、OCR 联调、聊天交互精简。原独立文件已删除，引用统一指向本文件。

## 偶发 401 与登录退出排查

## 事故与确定的缺陷

用户记录：删除 AI 会话后，`GET /api/v1/ai/settings` 未携带 Cookie，返回 48 字节业务 401，前端跳到登录页。旧进程没有保留完整请求证据，现有 `authGuard` no-token 临时探针予以保留。

确定的 Cookie 生命周期错误：`authCookie.buildCookieOptions` 的参数是秒，但 Express `res.cookie` 的 `maxAge` 要求毫秒。默认 `7d` 被传为 `604800` 毫秒，真实响应下发 `Max-Age=604`，Expires 约在 10 分 4.8 秒后。浏览器会在这时自动移除 Cookie，下一次受保护请求进入 no-token，响应拦截器再清前端会话并跳转登录。

这条链路与用户的 Cookie 缺失现象一致；缺少当次登录时间和 Cookie 元数据，尚不能断言历史事故只由这一项引起。48 字节本身不能区分“未提供认证令牌”和“无效的认证令牌”，两种响应均为 48 字节。

AI 删除会话只操作 AI 会话/消息数据，未清认证 Cookie、未透传供应商 Set-Cookie、未命中登出路由。Web 的 DELETE 会话和 GET settings 使用同一个 `/api/v1`、`withCredentials:true` 请求实例；模型 API 地址只是提交给后端的字段，没有改浏览器请求地址。

另外独立复现：有效 JWT 遇到数据库超时，旧 `authGuard` 与 `refreshToken` 都会再次查询数据库，再将异常误报为 401。这解释了一种“先卡再误踢”的路径，但不应将它当成已记录的 no-token 事故根因。

### 本次变更

- `src/common/utils/authCookie.js`：有效期秒数乘 1000 后交给 Express；默认 7 天实际下发 `Max-Age=604800`。httpOnly、SameSite、Secure、Path 和双通道策略保持原行为，登出仍立即清 Cookie。
- `src/common/middleware/authGuard.js`：JWT 验证和用户查询分开捕获异常。只有数据库明确报告缺少 `password_changed_at` 才兼容基础查询；超时、断连、其他缺列以及兼容查询失败均返回 HTTP 503 与业务 status 503，拒绝放行。新增数据库日志仅含错误 code，不打印 SQL、Cookie 或令牌。
- `src/modules/auth/controller/index.js`：刷新用户查询使用相同错误分类；数据库故障返回 503，其他运行时异常返回 500 固定文案。令牌伪造、过期宽限超限、密码变更撤销仍按原逻辑拒绝。
- `tests/unit/authCookie.test.js`：修正原先固化错误单位的两条断言，并使用真实 Express 响应序列化检查 7d/12h/30m/default 的 Max-Age、Expires 和 Cookie 清除。
- `tests/unit/authFailureBoundary.test.js`：使用真实合成 JWT、数据库和外围依赖替身，验证错误分类、查询次数、密码撤销、用户删除、无凭证及签发异常。

没有修改业务数据库、AI 入账逻辑或 Web 文件，没有启动 `app.js`。用户已有 AI 扩展、指纹调整、安全隧道状态码修改和临时探针均保留。本轮修改未提交，避免混入用户已有未提交改动。

### 验证

修复前真实 Express 序列化复现：7d → Max-Age=604，12h → 43，30m → 1。修复后对应 604800、43200、1800。

目标命令：

```powershell
node node_modules/jest/bin/jest.js tests/unit/authCookie.test.js tests/unit/authFailureBoundary.test.js tests/unit/pinGuardCookieChannel.test.js --runInBand --silent --verbose=false
```

回归包括数据库 ETIMEDOUT/ECONNRESET/PROTOCOL_CONNECTION_LOST → 503、一次查询、不放行、不下发 Cookie；缺少 password_changed_at → 唯一允许的兼容查询；兼容失败 → 503；伪造/过期/密码撤销 → 401；正常 Cookie/Bearer 和 PIN 通道保持可用。

前端实际 response/fileRequest 源码经内存 VM 验证，四条 HTTP/业务 503 路径均拒绝请求，清会话/导航/定时跳转次数为 0，无需为本次修复修改前端。

最终目标测试 3 组、70/70 通过；独立后端源码替身复验 26 例通过，并确认生产 Secure 属性和立即清除 Cookie 行为。Jest 提示现有配置项 ignorePatterns 不被识别，本轮未修改该配置。

### 运行验证与后续

1. API 加载新代码后重新登录。已签发的旧 Cookie 不会自动延长；仅重启 API 不能修正浏览器里已有的到期时间。
2. 仅查看 Cookie 元数据：默认 Max-Age 应为 604800，Expires 应约在 7 天后，不复制 Cookie 值或 Token。
3. 同一标签页静置超过 11 分钟，重新打开设置，再在临时空白聊天上验证删除会话 → GET settings 成功。历史事故的最终归因需结合此复测或现有探针。

以下为旁支风险，未在本轮扩展修改：旧 localStorage Bearer 可能覆盖有效 Cookie；AES 内存/存储缓存缺少失配后的重新握手；首个请求的外部 IP 与握手等待可造成卡顿；refresh 保留旧 iat 签发时新 exp 未真正延长（Web 当前没有调用刷新接口）；无登录标记的新标签页在 /auth/me 遇到 503 时路由仍可能去登录，但不会清 Cookie。

## 金额四位精度与信用卡显示修复

问题：人民币支出为39.91元，信用卡账单页面却显示39.9099元。API/Web均在当前 `feat/deepseek-ai-test` 分支修复，保留已有改动。

### 根因与真库结果

Web统一 `formatMoney` 原实现为 `Math.trunc(Number(abs.toFixed(6))*10000)/10000`。39.91先被转回二进制浮点数，再乘10000得到399099.99999999994，截断后变399099，最终少0.0001元。先toFixed(6)不能消除下一次乘法新产生的尾差。

信用卡账单列表、详情、账单流水均用此函数；普通流水列表则用toFixed(2)，因此相同原值在信用卡页面看起来错误。全额还款按钮也将此格式化结果填进表单，可能把39.9099用于验证与请求；千分位展示值如1,000.00则无法直接Number转换。

API `currency.formatCNY` 与外币 `toCNY` 存在相同倍率截断；formatCNY还会把小数段一起做千分位，形成39.9,099。人民币toCNY原分支与CreditCore的CNY账单写入对39.91本身正确；外币等价39.91会经错误折算进入账单写入，后续toFixed(4)无法恢复已少的0.0001。

`node tools/money-precision-verify.js` 已对真实库执行 READ ONLY 事务，输出仅本例计数与列类型：

| 核查 | 39.9100 | 39.9099 |
|---|---:|---:|
| 本人人民币信用卡支出原流水 | 1 | 0 |
| 本人信用卡账单bill_amount | 1 | 0 |
| 本人未删除的还款记录 | 0 | 0 |

实际列类型：account.amount、card_bill.bill_amount、card_bill.need_repay为DECIMAL(14,4)，card_bill.repaid及card_repay.repay_amount仍为DECIMAL(12,2)。本例存库正确，属于展示层错误。核查不输出流水ID、备注、账号或凭证，不改变数据。没有运行迁移、修整历史流水或批量取两位；历史外币/还款是否受旧实现影响不能仅按尾数推断，需要原始交易或银行结算证据。

### 修复

- 新 `src/common/utils/decimal.js`：字符串保留原十进制位数，Number先清理15位有效数字之外的IEEE尾差；金额列最多10位整数+4位小数，合法输入精度可保留。使用BigInt进行十进制定点截取、乘除和分位四舍五入，支持科学计数法。
- `currency.js`：人民币按既有“分”口径进行十进制四舍五入；外币按“100外币=rate人民币”精确乘除后截至4位；展示最少2位、最多4位，千分位仅处理整数部分。
- `CreditCore.aggregate`：仅对最终输出的额度、临额、债务、可用、溢缴总额及分组金额统一四位边界，清除跨月相加和共享池相减产生的浮点尾差；保留公式和数值响应类型。
- Web `money.js`：十进制字符串拆分/科学计数展开替代倍率截断，真实超过4位继续截断。如真实1.2345999显示1.2345，真实39.9099仍显示39.9099；不会把所有四位金额强制四舍五入到分。
- 还款页面新增无分组的 `formatMoneyInput` 填全额/共享金额，展示仍用formatMoney；欠款比较使用同一四位边界，避免39.90999999999999的计算尾差误拒绝39.91。

示例：39.91和数据库39.9100都显示39.91；0.8658/9.1132保留四位；1,000.00的全额还款表单值为1000.00。

### 验证

- API相关8套160/160通过：decimal/currency、CreditCore、外币完整链路/登记/对账、合并还款及正式账务事务回归。检查人民币单笔39.91、18.34+21.57汇总、外币39.91@100的账单INSERT参数和待还金额；跨月0.1+0.2、共享池差值、溢缴和真实超4位截断均通过。
- Web `npm run test:money` 6/6通过：覆盖10,000个分金额、字符串/Number/负值/科学计数法/大金额、Web与API格式一致；执行实际全额还款填值及提交函数，39.91、1000、1234.5678和计算尾差均正确；共享还款请求保持服务端计算金额。
- Web `npm run build`成功，相关语法/差异检查通过。
- 浏览器真实信用卡账单页面 `http://127.0.0.1:5173/card/bill/list?year=2026&month=11` 已确认账单与待还均为39.91，未点击实际还款。截图：[信用账单金额](D:/Code/live/temp/credit-bill-money-fixed-2026-11-06.png)。

复核命令：API `npm run test:money` / `npm run money:verify`；Web `npm run test:money` / `npm run build`。

## AI 持久化表增量迁移补齐

此前 `bus_ai_draft`、`ai_conversation`、`ai_message` 仅追加在 `mysql/live.sql`，缺少 `mysql/migrations/` 中的增量文件。已有环境采用默认启动迁移时无法创建这三张表。本次按 `mysql/README.md` 补齐，保留当前分支其他改动。

### 变更

- 新增 [018_ai_persistence.sql](../mysql/migrations/018_ai_persistence.sql)，按当前连续编号接在017之后，三条 `CREATE TABLE IF NOT EXISTS` 与 `live.sql` 的定义一致；草稿状态/版本/入账回执、消息meta与OCR溯源列一并包含。
- 将 `live.sql` 的 AI 建表块移到末尾 `COMMIT` 与字符集恢复之前，保证新环境导入时仍使用脚本设定的utf8mb4连接字符集；未改变现有列、索引或表选项。
- 更新 [MySQL说明](../mysql/README.md)：实际29张表、补漏007/008、018升级与重跑说明、AI表现有类型的例外及MySQL 5.7.8+要求。
- 在主README及AI模块README引用迁移与本日志。

### 数据边界与升级方式

018仅创建三个AI表，不含DROP、ALTER或账务DML，不插入样例，也不手工操作`_migrations`。已存在表被保留，结构差异或缺列不会由`IF NOT EXISTS`修复，应另写后续编号迁移。MySQL DDL并非事务整体回滚，若中途失败，已建表会保留，但运行器不会登记018；修复后重跑时可跳过已建表。

已有环境使用正常API启动迁移流程（默认增量模式，INIT_SKIP未开启）；迁移器按文件名排序，全部语句成功后登记文件名。新环境的完整建库源已含三表。完整`live.sql`含旧业务表DROP，不用于已有真实库的升级。

金额精度修复未改变表结构，不需新增金额ALTER迁移；旧007保留不变。

### 验证

本次仅进行静态与隔离迁移运行器验证，不连接或执行真实数据库迁移，不启动/重启服务。

- 文件编号001至018连续，文件名排序后018位于017之后。
- 三条CREATE定义与`live.sql`逐字一致；完整源共29张表，MySQL说明清单完全匹配，新增相关10个文档链接均可解析。
- 通过内存连接替身调用实际`runMigrations`：未建表时依次发送三条DDL再登记018；三表已存在时保留原数据对象；仅已建草稿表时可继续补齐其余两表；已登记后再次运行执行0个迁移。
- 模拟第二条DDL失败：首表保留，018不被登记；验证运行器不会把未完成文件标记为已升级。
- 实际`schemaSync.parseLiveSql()`能解析三张AI表；静态检查迁移正文仅包含建表DDL。
- `git diff --check`通过。上述替身验证检查运行器与SQL拆分/登记行为，未替代真实MySQL执行验收。

## AI 真实联调与账务边界修复

### 范围与状态

API / Web 分支均为 `feat/deepseek-ai-test`，保留用户原有持久化、人工入账与多供应商改动。本轮没有全量提交，也没有删除用户流水。

用户要求移除运行中的 mock，验证真实数据库和 DeepSeek 的读取、聊天草稿、人工写入边界及数据污染风险。旧 `tools/ai-sandbox.js` 与运行脚本移除；`AI_MODE=mock` / `AI_SYNTHETIC_DATA=true` 只能在显式 `NODE_ENV=test` 使用。单元测试保留独立 fixture，不能冒充真库验收。

### 已修复的链路

- 临时设置传给连接检查的字段修为 `baseUrl`，修复请求错误的 `undefined/models`；模型列表优先采用当前用户会话地址，切换地址须显式提供 Key，阻止隐式跨地址复用。Key 不回传、不落库、不写日志。
- 每轮 user/assistant 消息、最新草稿关联、更新时间同事务落库后再响应；所有历史读取限制登录用户。跨 store 实例可恢复上下文。
- 草稿和只读明细使用 `DATE_FORMAT` 返回日历日期，避免本地午夜经 UTC 导致前一天。
- 已核对草稿修改后重置 pending；编辑/核对/取消/提交同时校验版本、状态与有效期。已入账回执保留，并满足 Web 的 `needsReview=false` 与流水号契约。
- 模型无法唯一确认的无名/同名账户留空；明确的手工账户选择仍可用。真实候选只列正常账户。
- 特殊分类在候选、propose 与提交锁内统一拒绝，防止转账、购汇、证券买卖、还款、分期或初始化余额走普通单边记账；普通收入/支出名称不做宽泛关键词拦截。
- 正式提交只取库存档草稿字段，要求真实来源、本人、reviewed、当前版本；分类和正常账户在事务内加锁复验，人民币正式入账精确到分。
- 现金/余额/借记/信用写模型使用同一外部 executor：草稿占位、正式流水、余额/账单及流水回执一起提交/回滚。移除信用分支先占草稿再事务外恢复的路径，防止“已写账却报失败”或重复提交。
- 外部事务不再跑公共池虚拟卡初始化、资产聚合或未提交余额读取；普通借记入口也采用相同卡行锁协议。默认自管信用事务的提交后副作用异常不再误报未入账。
- 历史恢复重新读取本人草稿并恢复聊天卡片；过期/无法读取有准确说明，未入账草稿不再提示已有正式流水结果。已入账卡片不会因 15 分钟提案 TTL 显示成“已过期”。

认证问题另见上方《偶发 401 与登录退出排查》一节：Cookie 默认时长修为 7 天，鉴权/刷新数据库异常改为 503。此次浏览器查询、草稿编辑/取消、历史和 settings 读取没有发生被踢登录；用户报告的 DELETE 会话后瞬间缺 Cookie 尚未在当前进程复现，临时 no-token 探针保留。

### 真实验收方法

`ai:real:verify` 读取实际 `.env`，不加载 app.js，不启动迁移或定时任务。使用 AI 独立账号查询 `SHOW GRANTS`；确认只有 SELECT，固定只读仓库的汇总/明细数量一致，非本人哨兵身份无数据，检查涉及写入表的 InnoDB 与草稿列类型。

`ai:real:acceptance` 真正调用 DeepSeek 的 models/chat 接口和实际 MySQL 仓库、草稿/消息表、信用/借记模型。外层事务拥有真实连接，服务提交仅释放 savepoint，最终统一 rollback。验收前后比较正式流水、余额、账单、卡片及 AI 草稿/会话/消息的数量与校验摘要。它没有 mock 模型或数据库结果，executor 注入用于控制外层回滚。

核对项包括：真实连接、真实模型汇总与仓库一致、真实已有交易生成草稿、响应前历史落库、用户隔离、身份/SQL/分页拒绝、pending 不可提交、修改后重审、现金/借记/信用写模型、日期往返、回执契约及重复提交拒绝。失败尝试也执行外层回滚。

### 浏览器实际结果

真实 API 验证服务仅绑定 `127.0.0.1:7788`，使用正常 app 中间件/路由但不执行 app.js 主入口的启动迁移与定时账务任务。用户原有 API 进程未停止。Web 验证页面为 `http://127.0.0.1:5173/ai`，用户在页面登录后继续联调。

- 查询 2026-11-01 至 2026-11-06：收入 0 元、支出 10.01 元、2 笔，查询数据组件与账本首页一致。
- 根据已有 10 元停车费整理草稿：2026-11-04、交通、支出 10 元；账户与支付方式不明确时为 null，“核对完成”禁用。
- 在聊天卡片内修改备注为“停车费（界面联调，未入账）”后保存成功，仍要求补齐账户/支付方式。
- 取消该重复验收草稿后显示“已取消”，编辑/核对/入账操作消失。浏览器未点击正式入账。
- 历史恢复与设置读取的最后一轮结果见下方最终验证。

**用户明确要求保留** 2026-11-05、0.01 元、虚拟余额账户、备注“追加163入账验收”的既有测试流水。它仍计入上述支出，不把它误报为本轮新写入。本轮正式写模型验收全部回滚；浏览器联调仅新增 AI 聊天/草稿数据。

### 最终验证

| 检查 | 结果 |
|---|---|
| API `npm run test:ai` | 13 套，254/254 通过 |
| Web `npm run test:ai` | 11/11 通过 |
| Web `npm run build` | 通过 |
| `npm run ai:real:verify` | SELECT 权限、1300 条正式流水、25 个普通分类/81 个正常账户、汇总/明细 2 笔一致、非本人无数据、7 张相关表 InnoDB |
| `npm run ai:real:acceptance` | 19 项通过，真实供应商调用、三类实际写模型、最终 rollback，数量与摘要一致 |
| API/Web `git diff --check`、新增工具语法检查 | 通过 |

重启的是本轮自己启动的验证服务，用户既有 `app.js` 服务保留。真实页面继续处于登录态，设置 GET 显示当前用户只读账本且 Key 字段为空；历史列表成功恢复本轮消息。旧已取消提案超过 15 分钟后显示准确的无法恢复说明，未变成可入账卡片。

最后追加一轮真实草稿，历史列表显示 8 条消息；恢复后新草稿卡片保持 pending、10.00 元、2026-11-04、交通，账户/支付方式待选择且核对按钮禁用。打开编辑表单确认支出分类已去掉转账/提现/购汇/证券买卖。随后返回卡片并取消这份重复联调草稿，实际页面显示“已取消”且无写入操作。两份浏览器验收草稿均已取消，正式账本保留。最终截图：`D:/Code/live/temp/ai-real-chat-2026-11-06.png`，页面保留供用户继续测试。

### 实际边界与限制

已验证的是本轮查询区间、受控工具、用户隔离、版本/事务和三类现有写模型，不能据此声称整个复杂金融系统全面安全。模型解释仍可能不准确，金额与账户必须由用户核对，依据以服务端工具组件为准。

当前保留用户自定义 OpenAI 兼容 HTTPS 地址能力；本轮只实测 DeepSeek。HTTPS 与禁止重定向不是完整 SSRF 防护，允许不可信用户设置地址的部署仍需网络出口隔离或管理员地址允许列表。多实例限流仍需共享存储；全部历史、多币种对账、分期/冲正等专门业务未纳入普通草稿入账。页面实际测试中“我有多少张银行卡”得到功能范围拒绝，银行卡数量/资产统计不是本轮已验收的查询能力。

验证服务启动时，现有 secretGuard 报告开发配置的 JWT/分享签名密钥强度不足并按开发模式放行；本轮未改凭据。当前本机联调结果不能作为直接生产上线结论，生产模式应按既有密钥强度保护检查配置。

`formalWriteEnabled=false` 是现有 v1 聊天工具契约，不能理解成整个 API 禁止正式写入；人工 `/drafts/:id/commit` 已存在。已同步 [模块说明](../src/modules/ai/README.md) 和 [API README](../README.md)。

## AI 业务开放评估与 OCR 联调

API/Web：`feat/deepseek-ai-test`。本轮保留原有未提交改动与用户指定保留的旧 0.01 验收流水；没有修改真实 `.env`，没有清理真实账务。

### 业务开放报表

[完整评估报表](AI_BUSINESS_OPENING_ASSESSMENT_2026-11-06.md) 统计当前实际挂载的 20 模块、23 路由组、183 HTTP 接口，并列出全模块开放矩阵、14 个建议工具、10 类 GET 写副作用及金额口径。建议先增加预算、纯待办、普通周期计划和工资查询，再适配余额/债务/资产/基金等只读投影。新增建议尚未注册为模型工具。

### 实现

- 新 `POST /api/v1/ai/ocr` 复用正式鉴权、AES、安全请求、PIN 与聊天限流，不加入公开上传白名单。
- `service/ocr.js` 核验静态 JPEG/PNG/WebP、2MiB 编码和 24MP，Sharp 去元数据并重编码。只接受本次图片 dataURL，不取外部 URL 或本机路径，不保存图像。
- 官方 DeepSeek 视觉使用 `deepseek-flash` 与当前 Key，固定 JSON 提取提示，无工具、60 秒超时、禁止重定向。上游 401/403 返回本地 502，避免误触发登录退出；不记录原始错误、图像或密钥。
- 严格识别字段上限、日历日期、金额精度、交易状态与类型；长数字和链接输出脱敏。单笔普通 CNY 需日期/金额/状态/性质/方向/金额符号识别文本内部一致才生成待核对草稿，账户始终由用户选择。特殊交易正文同时拦截常见中英文名称。
- 多笔账单、特殊/未完成/不完整识别仅展示核对结果，最多 20 条，无批量入账。相同图片顺序重传恢复原待核对草稿或已入账回执。
- OCR 结构化结果保存在聊天 meta，恢复受限不可信上下文；无新草稿的 OCR 清空旧草稿指针。人工入账支持 image-ocr 来源，仍需补齐、核对、当前版本、本人归属、有效期与同一事务。
- 图片草稿尚待核对时，通过聊天补充字段更新原草稿 ID/版本，保留原图片哈希、来源及识别依据，编辑后重置 pending；记录另一笔交易需开始新对话。拒绝美元符号证据生成人民币草稿，避免内部币种矛盾。历史恢复查询 trace；草稿临时读取失败返回可重试状态，区别于过期。
- Web 新增图片选择、内存预览/移除、单独外发同意及 OCR 重试；历史恢复识别表。草稿卡为主要输出，依据折叠，避免重复字段说明。

### 已完成验收

`node tools/ai-real-ocr-acceptance.js`：14 项通过，真实 DeepSeek 视觉与聊天、真实 SQL 与正式写模型，无识别替身。输入为仓库内两张非私人验收样图，不是用户真实支付截图。

1. 图片未同意时拒绝调用。
2. 单笔图识别 12.34 元、2026-11-06、普通已完成支付，生成 pending 草稿且账户为空。
3. 识别前后流水、余额、账单、卡片数量和摘要一致。
4. 账户缺失和未经核对均禁止提交。
5. 对话、草稿及图片哈希查询按本人隔离。
6. 相同图片顺序重传复用草稿。
7. 结构结果可恢复到历史且历史不含图片编码。
8. 多笔图识别 10、25、8.50 共 3 条，不把汇总 43.50 元作为交易。
9. 多笔账单不产生草稿，并清除旧草稿上下文指针。
10. 人工补账户/分类、核对、正式写入与回执使用同一外部事务。
11. 相同草稿重复提交拒绝。
12. 已入账图片重传显示原回执。
13. 外层回滚后，流水、余额、账单、卡片及全部 AI 表计数/摘要与验收前一致。
14. 真实模型通过聊天补充唯一命名的账户，仍更新同一图片草稿 ID，版本递增、hash/source 保留且草稿数不增加；入账后原图恢复该草稿回执。

样图：`tests/fixtures/ocr-payment.png`、`ocr-statement.png`；可通过 `python tools/ai-ocr-fixtures.py` 重建（需要 Pillow 与 Windows 微软雅黑字体）。验收工具不会启动 app.js 迁移或账务定时任务，不输出私人流水/密钥。

自动回归：API `npm run test:ai` 15 套 **304/304** 通过；Web `npm run test:ai` **24/24** 通过，`npm run build` 成功。包含真实 Sharp 图片校验、无工具视觉请求、脱敏、上游 401、越权/同意/连接版本、方向符号/币种与证据矛盾、特殊交易、同图重传、OCR SQL 存储恢复、无草稿时清指针、image-ocr 信用/借记同事务和失败回滚、聊天更新同一图片草稿与历史查询依据恢复。自动回归使用隔离替身，真实调用由上述独立验收工具覆盖。

浏览器 `http://127.0.0.1:5173/ai` 已通过真实登录 Cookie、安全请求与 AES 链路上传两张样图。支付图显示 12.34/2026-11-06/交通/微信且账户待选，核对按钮禁用；取消只更新并折叠原卡片。账单显示三条识别明细，无普通草稿。图片预览阶段未发送，发送要求独立同意；草稿/账单显示后不重复输出助手字段文字。本轮浏览器未点击正式入账，验收支付草稿已取消，识别结果保留供查看。窄屏标题和账单明细改为完整可读布局，宽屏仍使用表格。

刷新后从本人历史恢复，已取消草稿及三条 OCR 结构结果仍显示，原图预览不保留。最终窄屏截图：[OCR 账单界面](D:/Code/live/temp/ai-ocr-statement-2026-11-06.png)。SQL 安装源只补 `source` 注释，不运行迁移或改变真实表结构。

浏览器另行验证图片草稿续聊：上传 12.34 元样图，再以聊天要求改为 13.34 元，原卡金额更新且页面只有 1 张草稿卡，原 OCR 依据保留、账户仍为空且核对按钮禁用，未追加重复助手确认。该验收草稿最终取消，未点击入账。截图：[续聊原卡更新](D:/Code/live/temp/ai-ocr-followup-2026-11-06.png)。

### 实际限制

识别置信度和原文依据来自模型，内部一致不能证明现实交易事实。去元数据/输出脱敏不会遮挡外发原图可见个人信息。变图与跨实例同时上传未全局防重，多笔账单未实现行选择或批量入账。自定义供应商视觉、完整真实银行截图样本准确率、全部业务金额口径尚未验收；这次通过不是整个金融系统的全面安全证明。

官方视觉依据：<https://api-docs.deepseek.com/guides/vision>、<https://api-docs.deepseek.com/quick_start/pricing>（2026-11-06 核实）。

## AI 聊天草稿交互精简

用户反馈：模型先逐项复述日期、金额、分类等，再显示同样内容的草稿卡片；取消后卡片与新增助手消息重复提示“已取消”。

### 调整

- 有草稿卡片的成功消息只展示卡片和已有查询组件，隐藏重复模型文本及“财务助手”文字标签。普通回答、没有卡片的追问、请求错误及重试入口照常显示；历史恢复成功的卡片应用同一展示规则。
- 编辑、核对、取消、入账只更新原卡片，不再追加一条助手确认消息。保存成功在卡片内显示简短“修改已保存”，核对/取消/入账通过状态和回执表达。
- 已取消或过期的卡片默认显示金额、分类、日期摘要，可通过“查看详情/收起详情”展开或收起。详情按钮只控制展示；失效草稿仍无修改/核对/入账操作，错误不会被折叠隐藏。
- 已核对卡片移除重复“已核对”按钮，保留修改、入账和取消；已入账移除重复徽章，仍显示已入账状态、正式回执及流水入口。

### 验证

- Web `npm run test:ai`：11/11 通过。
- Web `npm run build`：通过。
- 真实页面历史恢复确认：有卡片的消息不再显示模型字段复述；取消卡片默认只显示金额、分类、日期和“已取消”。展开显示原始字段，收起恢复摘要，均无编辑/核对/入账按钮。普通银行卡数量范围回答仍可见。
- API/Web `git diff --check`：通过。
- 实际截图：`D:/Code/live/temp/ai-chat-ux-2026-11-06.png`。

本轮只调整 Web 展示与交互反馈，未改 API 写入链路、草稿版本/有效期、人工入账确认或权限规则。没有提交正式流水或删除既有数据。

---

## 来源：CHANGELOG_2026-11-06_AI_BUSINESS_IMPLEMENTATION.md

# 2026-11-06 AI 业务实施与验收记录

负责人在PLAN规划后直接授权实施，并明确“一定一定要阻止循环请求”。本轮依据计划`AI-OPEN-20261106`版本1.1增加R-025/A-023，源码仍在API/Web `feat/ai-assistant`工作区；未提交、未部署，不宣称22项任务全部完成。当前状态以[PLAN台账](../../Docs/docs/ai/PLAN/task-tracker.md)为准，来源/文件证据见[溯源](../../Docs/docs/ai/PLAN/traceability.md)。

## 来源和保留基线

API起点`35fae48a9d6c061e12475c2a75345ffcd22c312d`，Web起点`a842dd179e9251620e469abd1890af1144db4205`，两端分支`feat/ai-assistant`。负责人原报告保留，冻结快照79,317字节、SHA-256 `f727a43627a07528fb8c02563e485ddea3d74d436b06464e88ee9f7a6a5f640d`；来源manifest仍描述版本1.0规划，不回写原hash。保留Web Login.vue用户修改与负责人决定保留的旧验收支出。

## 已落地行为

- v2服务器prepare获准范围→安全预览→一次DeepSeek JSON答复/最多一个提案。新聊天最多1次provider，OCR最多1次，legacy兼容至多4次且重复工具立即停止。没有tool loop、输出修复或自动重试。
- 持久requestId claim/user lane/调用计数和回执，跨进程并发互斥、每分钟6次、重入拒绝、超时abort；同预览CAS单次消费，换requestId也不再发。断线恢复仅读回执；Web挂载/恢复/设置变化不自动发模型。
- 十域纯SELECT：账本、余额、信用卡、预算、待办、工资、资产、固定资产、基金、分期。CNY至分/外币收益四位；缺快照/汇率明确不完整。补逐卡/月CNY消费/类型数量/到期月份/配置还款日、香港/一日游固定LIKE、type+currency余额组成。旧资产总额无币种证据，标unverified、同日差额null；读取不补写、还款、对账、分期入账、作废或折旧。
- 全出口随机refs；v2预览≤64KiB/每dataset≤100行/≤12个月，map15分钟加密存档，digest绑定scope/指纹/连接/会话/原话/map。预览与实际外发同包，最多4条500字用户历史和候选同样展示。旧v1历史/最近草稿/工具结果隐藏真实ID和联系方式，只反解本轮refs。
- 未消费preview可服务器撤销，approved_at=-1；审批/外发/ref反解/消费CAS拒绝撤销竞态，已发不能撤回。本人过期payload/refMap以100行有界批次清理，保留id/digest/批准/request证据；历史未知UUID/旧refs/sk-key文本通用隐藏，typed金额和新refs不误遮。
- 类型化提案与白名单固定执行器、版本核对/目标快照、人工ID+version执行和同事务回执。支持预算、todo、私有日记、卡alias/status、固定资产名称/品类和可分离回收/恢复/永久删除、基金明确日收益、管理员固定备份提案。
- 聊天内数据表/安全图/提案卡、每日default唯一锚点、manual新会话、多卡和回执恢复代码。模型文字不重复卡片字段，不声称已执行。
- `businessPolicy.js`分域/动作开关：production默认v2关闭/新动作空，本地开发默认安全清单；false可关闭新入口。未知配置项拒绝。

## 实际测试证据

| 检查 | 结果 | 源码/关联任务 |
|---|---|---|
| 最终统一API AI回归，[JSON结果](./ai-business-evidence/api-ai-tests.json)/[运行日志](./ai-business-evidence/api-ai-tests.log) | 25套469项，0失败 | 原全部AI与新HTTP契约8/scope9/policy3，包含只读18/预览17/egress4、动作17/guard13/service13/intent57；子集不再相加；T-001～T-021局部 |
| API `npm run test:money -- --silent --json --outputFile=logs/ai-business-evidence/api-money-tests.json`，[结果](./ai-business-evidence/api-money-tests.json) | 8套160项，0失败 | CNY39.91、真实四位/外币、信用与原普通入账金额回归；T-005/T-008/T-021 |
| Web `npm run test:ai`，[日志](./ai-business-evidence/web-ai-tests.log) | 43项，0失败 | `aiBusinessContract.js`/`aiBusinessHistory.js`及聊天组件，新增中文日程/优先级枚举显示验证；T-003/T-010～T-022局部 |
| Web金额回归，[日志](./ai-business-evidence/web-money-tests.log) | 6项，0失败 | 金额显示/完整还款金额输入的既有前端路径回归，不开放AI还款 |
| Web `npm run build`，[日志](./ai-business-evidence/web-build.log) | 退出0 | 构建通过；不替代实际浏览器交互 |

隔离单测显式注入内存仓库、供应商和请求基础设施；内存guard执行真实防重逻辑，不用公共数据库回退，也不为模拟模型放松真实refs检查。测试计数不等于原A清单全部通过。早期旧AI15套304、新读29→35→37→39、Web36项等阶段结果保留在PLAN活动日志；本表只报最终统一验收数量。两端`git diff --check`退出0，源报告SHA仍为上述冻结值。

## 真库、权限与真实供应商

1. `tools/ai-business-migrate.js`仅019 AI结构，两次执行幂等；新5个AI基础表与每日会话字段/索引，26非AI正式表数量/摘要不变，未运行旧账务迁移。
2. 只读account域曾因SELECT权限不足失败。按负责人已授权范围，`tools/ai-business-read-grants.js`仅补17静态业务表SELECT，禁止database.*或写权限；5认证/密钥敏感表真实访问被拒绝。
3. `tools/ai-business-real-verify.js`最终通过十域22数据集（卡6/资产4）本人/不存在用户隔离查询、真实preview撤销阻止审批/外发/ref反解及消费CAS0、已消费拒绝撤销，以及安全动作/guard真SQL savepoint/外层事务回滚；26非AI及35全库表行数/SHA完全一致，旧验收支出保留。遗留queued/running job转failed且不重跑也通过。该脚本provider=0、backup=0；[实际结果](./ai-business-evidence/real-database.json)明确单真实连接序列savepoint，不用它证明物理并发。
4. 最终`tools/ai-business-provider-acceptance.js`[实际结果](./ai-business-evidence/provider-acceptance.json)7检查通过，3次真实provider分别是财务查询、待办草稿、39.91普通收支草稿，每轮1次；重复requestId或同preview无额外调用，历史恢复不发provider。AI写入全部外层回滚，正式账本不变。
5. [双物理pool真实并发结果](./ai-business-evidence/physical-concurrency.json)独立验证2个pool/2个guard连接：运行同id409、不同id跨pool429、完成/失败/超时/过期墓碑不重放、每分钟6次共用预算与窗口恢复，9项检查通过；拒绝后额外work0、externalProviderCalls0。只清理随机不存在owner的exact生成fixture，残留0，26正式表不变。
6. [真实UI摘要](./ai-business-evidence/ui-acceptance.json)17项交互通过，页面保留`http://127.0.0.1:5174/ai`：待办11-07/改备注/核对/取消、中文枚举；非私密验收支付图12.34/日期/交通/微信，缺账户不能核对，已取消；statement3行10.00/25.00/8.50，仅识别表，排除43.50合计，无批量草稿。DOM image/blob/dataURL均0、回执无图片字节。刷新恢复default/取消态/账单表/输入，[请求计数](./ai-business-evidence/ui-request-counts.json)和[独立复核](./ai-business-evidence/ui-reload-verification.md)证明同三个UI请求各provider_calls1/max1，刷新前后3→3，0新请求/0新provider/0正式流水和todo。计数采集器自身provider0；此UI3次仅统计本轮界面，区别于前述脚本3次和早期失败调用。

早期provider验收在todo读取权限不足时中止，失败前已经调用财务query。此前阶段性“provider=0”描述不准确，不能沿用到这些运行；最终成功运行的3次与早期失败运行分别统计，详细阶段/次数以验收脚本实际输出为准。SQL回滚不能撤销已发生的付费调用或供应商接收数据；脚本没有自动重试。

## 仍未完成与明确排除

真实浏览器已验证上述待办/OCR/刷新范围；正式业务UI执行、全域图表/扩域授权/全部多卡交互、手机/跨天/断线全路径另验收。预算/指定卡消费日期/资产组成已通过最终真SQL；总额币种不明保持差额null，是明确边界。固定资产AI正式新增与精密参数修改由R-024取消，T-017对应部分superseded；安全预填完成，actionUnavailable阻止正式创建，原产品创建/图片缺口另记，不扩大本轮范围。备份权限/固定提案/任务代码和重启遗留job不重跑已测，实际文件与关闭演练未验收。暂无部署commit/PR或released任务；非私密验收图识别通过不保证任意个人截图准确。

实际还款、转账、冲正、退款、外币对账、分期入账、余额重建、正式折旧/精密重算继续排除。基金仅保存用户明确日收益，不推算本金/收益/汇率；不新增认证、私密资料、位置、分享或分类写入。

## 变更文件与溯源

P0：`service/businessService.js`、`businessIntent.js`、`businessPolicy.js`、`requestGuard.js`、`businessRead.js`、`analysisPreviews.js`、`egressPolicy.js`、`businessProposals.js`、`api/index.js`、`service/index.js`、`service/conversations.js`、`service/deepseek.js`、`service/ocr.js`，路径前缀`src/modules/ai/`。固定执行器：`src/common/services/aiBusinessActions.js`。结构：`mysql/migrations/019_ai_business_workspace.sql`、`mysql/live.sql`。Web：`src/views/AI/Assistant.vue`、`src/components/ai/AiPreviewCard.vue`、`AiDatasetCard.vue`、`AiProposalCard.vue`、`src/utils/aiBusinessContract.js`、`aiBusinessHistory.js`及对应测试。

原E-001～E-014保留为版本1.0基线；本轮实现/验证另列E-015～E-029，E-025为物理双pool、E-028为真实UI/刷新、E-029为独立实施SHA清单；R-025横切T-001/T-003/T-006/T-012/T-021/T-022，验收A-023。PLAN台账/实施计划/决策/溯源/活动日志已更新1.1，当前25R/22T/23A，源报告和旧规划日志保持历史含义。当前未提交源码/文档/实际证据哈希见[实施清单](../../Docs/docs/ai/PLAN/sources/implementation-manifest-2026-11-06.json)，不回写旧source-manifest。

---

## 来源：CHANGELOG_2026-11-06_AI_FINANCIAL_PREPROCESSING.md

# AI 财务预处理与风险防护执行记录

日期：2026-11-06；来源：S-008“执行，一定要规划全场景预处理和风险防范”。API/Web均在feat/ai-assistant，工作区未提交、未部署。完整规划和逐层证据见[PLAN执行状态](../../Docs/docs/ai/PLAN/next-stage/execution-status.md)与[66场景台账](../../Docs/docs/ai/PLAN/next-stage/scenario-evidence.json)。

## 实际行为

- 普通人民币流水先解析账户实体，再识别金额；借记卡000不成为第二个金额。千/万单位由服务器确定性计算；含糊、负数、复合单位、指数形式、非法日历、未来日期、混币和禁止特殊账务不能默默转为普通流水。
- 39.91与尾零39.9100保持39.91；39.9099、0.001拒绝并要求手工明确，不能自动舍入或修复历史库。合法0.01保留。基金明确日收益的四位/正负规则独立保留。
- 本人真实账户、同币种应用账本纯读预检；借记使用正式账本源，信用使用实际CreditCore与共享额度池。缺失/脏源/容量超限/超时保持不可核验，禁止余额0或汇率1回退。没有银行实时可用余额证明。
- 不足、含糊、缺账户只生成非执行核查候选。补字段、重新核验、创建草稿、编辑、核对、取消和恢复均0次模型调用。余额不足不能生成可执行草稿；修正金额或账户后本地重检。
- 默认小于1元仅提示；1000元起提醒；10000元起需手工确认完整金额；使用至少50%可用资金提醒。阈值不是错误判定。近90天同币种/方向/类别至少30笔才可用中位数+6MAD提醒；样本不足、截断、坏数据或零MAD不作强统计结论，不更改历史样本。
- 编辑撤销核对。资金、字段、来源、政策和风险digest绑定当前版本；核对后变化需重核对。提交只收id/version，同事务锁本人分类、账户及共享池，复验最新资金、写正式流水与回执；失败整组回滚。手工普通收支入口也使用资金防线，实际旧转账业务保留专门分类/支付语义，不开放给AI。
- OCR只对合格单笔已完成CNY支付给候选；缺账户需手工选择。图文金额/方向/日期冲突必须手工填相应字段并留修正证据；未支付、特殊、多笔/汇总、外币或不可靠源不能靠覆盖字段洗白。原图只在本次内存，持久化加密候选和短结构化证据。
- 请求号和图片来源指纹保留墓碑；候选消费CAS最多一份草稿。本地候选、草稿和恢复回执同事务，事务后历史失败恢复原草稿。GET及重复POST取当前版本，取消/过期/入账不回放旧pending卡。v2和OCR最多1次模型，旧v1明确最多4次，无自动重试/修JSON/模型回退/循环。
- 同进程源读取、锁等待、模型回复后及提交前重验当前开关；关闭后不新增可执行草稿/正式流水，已提交回执和取消仍可用。跨进程配置一致发布另需演练。

## 最终证据

| 验证 | 结果 | 范围 |
|---|---|---|
| [API AI](ai-business-evidence/s2-api-tests.json) | 33套732/732 | 规则、契约、请求预算、归属、来源、关闭竞态、回执与事务adapter |
| [资金源](ai-business-evidence/s2-funds-final-tests.json) | 3套34/34 | test:ai文件名范围外的正式资金预检/读池/CreditCore |
| [金额回归](ai-business-evidence/s2-money-tests.json) | 8套176/176 | 包含与AI重复套件，不能与AI相加当总数 |
| [Web AI](ai-business-evidence/s2-web-final-ai.log) / [金额](ai-business-evidence/s2-web-final-money.log) / [构建](ai-business-evidence/s2-web-final-build.log) | 64/64、6/6、退出0 | 组件、调用契约与生产构建 |
| [隔离真MySQL](AI_FINANCIAL_ISOLATED_VERIFY_2026-11-06.json) | 56/56 | 合成39.91/0.01正式写、资金边界、双物理writer、人工与AI竞争、共享信用池、SQL故障回滚；正式库26表摘要不变，provider0/defaultPool0 |
| [本地恢复补充真MySQL](s2-local-recovery-isolated.json) | 6/6 | 同事务恢复payload故障、提交后历史失败、取消/过期/已入账GET/POST；未新增正式记录，两个库财务摘要不变 |
| [真实桌面UI](ai-business-evidence/s2-ui-acceptance.json) | 10/10 | 缺账户、1000提醒、16000不足、39.9099拒绝、39.91候选转草稿、30秒过期、本地重检核对、取消、重启/刷新恢复 |
| [020迁移](ai-business-evidence/s2-live-schema-migration.json) / [静态权限](ai-business-evidence/s2-live-read-grants.json) | 通过 | 仅新增AI候选表，幂等；18业务表SELECT/5敏感表拒绝，正式26表摘要不变 |

本轮页面请求计数增量1、candidate增量1、draft增量1，provider增量0；正式26表摘要不变。没有在正式库执行commit，旧验收0.01记录按用户要求保留。截图[非法分位](ai-business-evidence/s2-ui-invalid-precision.png)、[取消后恢复](ai-business-evidence/s2-ui-cancelled-restored.png)未展示真实余额。早期11个失败是测试设施缺少恢复SQL事务支持，保留[失败证据](ai-business-evidence/s2-api-tests.failure-before-fixture-recovery.json)，不列为当前通过证据。

## 明确保留的验收范围

66个主场景和11个时序变体已规划并逐层溯源；局部通过不等于全部场景verified。真实手机、上海午夜跨天、浏览器三阶段断网、真实COMMIT回应丢失/死锁、所有生活业务完整UI、备份实际文件与隐私全生命周期、生产灰度及跨实例关闭演练仍待专项验收。任意个人支付截图的现实准确性尚未证明，模型自报证据不能替代人工核对。

仅保留独立本机联调服务：127.0.0.1:5174/ai指向7789，加载最终源码；没有停止用户既有7788服务。当前开发服务的密钥强度检查有配置告警，生产启动守卫会拒绝不合格配置；没有修改或输出密钥。此次结果不能当生产发布验收。

原意见报告及上一阶段冻结manifest不覆盖。最终源代码、文档、证据SHA记录在[S2实施清单](../../Docs/docs/ai/PLAN/sources/s2-implementation-manifest-2026-11-06.json)，不冒充Git提交或上线记录。

---

## 来源：CHANGELOG_2026-11-06_AI_OPENING_PLAN.md

# 2026-11-06 AI 业务开放规划与溯源

依据负责人更新的`AI_BUSINESS_OPENING_ASSESSMENT_2026-11-06.md`，派出业务、安全、交付三个子代理独立只读分析，主代理汇总[最终PLAN](../../Docs/docs/ai/PLAN/README.md)。本次仅文档，不实现新增业务、改变真实数据或运行服务/模型/备份/迁移。

## 来源与最新决定

- API/Web当前基线为`feat/ai-assistant`，分别`35fae48a9d6c061e12475c2a75345ffcd22c312d`与`a842dd179e9251620e469abd1890af1144db4205`。
- 原报告79,317字节，SHA-256为`f727a43627a07528fb8c02563e485ddea3d74d436b06464e88ee9f7a6a5f640d`。按原始字节冻结副本，保留负责人原文件改动；不把旧报告首行分支名当成现状。
- 负责人本轮明确：实际还款不开放，涉及精密数据处理不包含AI接入；OCR仅本次处理、不落盘。这两条答复独立存档并映射到D/R/T/A编号。
- 固定资产原“全套”范围按最新决定收窄，正式折旧/精密重算回原入口；基金仅登记用户明确收益，不由模型推算收益或本金。

## 交付文件与跟踪

`Docs/docs/ai/PLAN/`包含最终实施计划、22任务台账、24需求与22验收溯源、决策表、活动日志、三份子代理分析及源报告/答复/源码hash清单。实施任务初始全部planned，不能把规划完成当成新增功能完成；后续任务变更须填入commit/PR、测试、独立复核与真实验收范围。

同步AI文档首页与VuePress导航，主API README引用本日志和计划。Docs当前不是Git仓库，以版本/快照/hash/日志提供文件级溯源，不编造提交记录，也未建立定时自动任务。

## 关键前置缺口

- 现有真实候选ID、近期草稿、历史和工具结果尚无统一外发map；布尔consent尚未绑定具体数据范围。
- v1前端契约仅单笔普通收支；新增业务需v2及独立类型卡片、固定executor和核对回执。
- 单日会话需数据库唯一default锚点，同时解决latest_draft_id单目标覆盖问题。
- 固定资产表单占位、图片必填与0残值校验问题；状态/年限/残值改动含精密副作用，不能直接复用。
- 基金现单笔历史接口缺外部事务，批量需归属、父基金锁、现有日期唯一键及整批写入/汇总/回执一致。
- 系统备份只能管理员固定后台任务，回执不含SQL/内部路径/凭据；文件副作用另测，不能宣称数据库事务可整体回滚。

## 验证

本轮执行文档结构、来源hash、编号/覆盖、源码行号与链接检查，以及Docs构建检查；具体结果在PLAN活动日志中追加。未进行新增AI能力的自动测试或真实数据库/供应商验收。

最终检查通过：原报告快照与工作区SHA一致；37个源码证据文件hash、83处直接源码行号、19个内部链接有效；24R/22T/22A双向映射一致，显式编号依赖无环，22实施任务全部planned。`npm run docs:build`成功渲染58页，包含9个PLAN页面；API `git diff --check`通过。Web仅保留原有Login.vue用户改动，API业务源码/SQL/配置无本轮差异。
