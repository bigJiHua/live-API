# DeepSeek AI 测试版（契约 v1）

API 与 Web 均使用 `feat/deepseek-ai-test` 分支。此阶段验证工具调用、用户隔离和草稿隔离，**不提供正式入账接口**。

## 接口约定

全部接口位于 `/api/v1/ai`，沿用正式 API 的认证、安全请求头、AES 信封与 PIN 中间件，不新增鉴权白名单。所有响应 `Cache-Control: no-store`。

| 方法 | 路径 | 输入/用途 |
|---|---|---|
| GET | `/capabilities` | `contractVersion=1`、模式、是否启用、是否需要数据外发同意、`formalWriteEnabled=false` |
| POST | `/chat` | 业务体 `{message, scene: "chat", consent: boolean, conversationId?: UUID}`；Web 请求层包装为 AES 信封；兼容旧query/draft场景 |
| GET | `/drafts/:id` | 仅允许草稿所属登录用户读取，过期与无权限均返回404 |
| PUT | `/drafts/:id` | `{version, fields}`：在聊天卡片内修改完整草稿字段，重新校验账户、分类和金额 |
| POST | `/drafts/:id/action` | `{version, action: "review"或"discard"}`：仅标记核对或取消，禁止正式入账 |
| GET | `/settings` | 当前用户的临时连接状态、官方API地址、模型与有效期；不返回Key |
| PUT | `/settings` | `{apiUrl, apiKey?, model}`；检查官方models接口成功后应用，省略Key仅可复用本人已有临时Key |
| DELETE | `/settings` | 清除当前用户临时Key并清除该用户聊天上下文 |

`chat.data` 返回 `{contractVersion, mode, answer, conversationId, source, formalWriteEnabled, trace, draft}`。能力声明还包括 `chatEnabled=true`、`draftEditingEnabled=true`，防止旧后端配新界面。`trace` 包含工具名称、`readOnly=true` 和服务端实际结果；Web 在聊天内展示查询依据和交互草稿卡片，模型文字仅作为解释。不能通过工具或任何确认路由执行正式写入。

## 工具与权限

- 查询场景仅提供 `query_finance_summary`、`query_transactions`。
- 草稿场景仅提供 `list_record_choices`、`propose_transaction`。
- 连续聊天场景提供上述四个受控工具，由模型按自然语言选择，用户无需切换标签。
- 用户身份只取 `req.userId`；模型参数不能包含用户身份、SQL、URL或额外字段。
- 模型调用由后端按静态名称映射执行，不使用 `eval`、任意HTTP请求、动态模块加载或模型生成SQL。
- 日期按真实日历及 `Asia/Shanghai` 校验，查询最多93天；明细最多20条，分页偏移最多100。
- 每次最多4次工具执行，最多4轮模型请求；每个进程每用户每分钟6次，禁止同用户同时调用。多实例部署还需共享限流存储。
- 草稿修改/核对/取消合计每用户每分钟最多30次，修改必须携带当前版本；冲突返回409，不静默覆盖。
- 草稿仅允许单笔普通人民币收支。账户/分类必须属于当前用户且类别与方向匹配；歧义字段保留null。**这些校验不能证明金额符合真实交易，草稿始终需要人工核对。**
- 草稿存在独立进程内存，15分钟过期、最多500条、服务重启清除。编辑不延长过期时间。状态为pending/reviewed/discarded，核对不入账，取消后不可编辑。返回副本防止修改已存版本；此版本不承诺跨进程或重启后的草稿访问。
- 连续对话同样保存在按用户隔离的进程内存：30分钟空闲过期、最多500个对话、只保留最近10条服务端生成的user/assistant消息和少量查询范围元数据，不保存全量明细。客户端只能传conversationId，不能上传模型history/messages或身份。追问读取当前已编辑草稿；过期/其他用户对话返回404。Web聊天仅存在页面内存，离开或刷新后清除，不写localStorage/sessionStorage。
- 日志不记录DeepSeek密钥、用户原文、查询明细或供应商原始报错。

## 真实只读查询

聊天页“新对话”左侧设置按钮支持填写DeepSeek官方API地址和Key，选择 `deepseek-flash` 或 `deepseek-v4-pro`。需要后端显式设置 `AI_ALLOW_SESSION_SETTINGS=true`；默认关闭。仅接受 `https://api.deepseek.com` 官方地址（兼容/v1和/chat/completions输入），实际models/chat地址由代码固定，拒绝外部域名、内网、HTTP、凭据URL、查询参数和重定向。

Key仅保存在后端按登录用户隔离的内存中，1小时后失效、最多500份；不改.env或数据库，不回传Key，不记录密钥或供应商原始错误。Key输入框关闭/成功应用后清空，不写浏览器存储。设置操作每用户每分钟最多5次并禁止并发；仍经过正常鉴权、安全头、AES和PIN链路。配置变更清除本人的短期聊天上下文；Web携带connectionId，临时配置过期时返回错误，不能静默变回模拟回答。

“检查连接并应用”调用官方 `/models` 检查Key及模型权限；成功后实际对话仍须明确同意发送对话和必要查询数据。连接检查不是成功对话或真实工具调用的证明。

默认 `AI_MODE=disabled`。在站点后端配置 `.env.example` 中的 `AI_MODE=deepseek`、`DEEPSEEK_API_KEY`、`DEEPSEEK_MODEL` 和独立 `AI_DB_*`。

建议先连接隔离的测试库。数据库管理员应给独立账号仅授予 `account`、`bus_category`、`card_base` 的 `SELECT` 权限，并核对 `SHOW GRANTS`。代码拒绝root及不完整配置，但不能替代管理员核验授权。

该模块不导入正式可写连接池，也不调用旧业务模型。每次工具查询开启 `SET TRANSACTION READ ONLY` + 事务，执行固定参数化SELECT后回滚结束。数据库拒绝只读事务时停止查询，不降级成可写连接。

连接池最多2个连接、队列最多8个请求；连接/查询超时5秒，DeepSeek请求超时20秒。供应商地址固定为 `https://api.deepseek.com/chat/completions`，禁止重定向和自定义工具URL。Web调用超时120秒。

只读事务仍允许读取同一库内其他用户的数据，因此所有固定查询及关联均显式绑定当前用户；不能只依赖数据库账号的SELECT权限实现用户隔离。

汇总口径v1：剔除所有标记为“转账”的流水、信用卡还款、已删除及冲正记录；外币按记录汇率的每100外币口径折算为人民币，逐笔四舍五入到分。**所有“转账”标签均排除，含现有对外转账标签；尚未统一既有页面全部报表口径，也未引入信用卡外币银行实际对账口径。** 这不是资产/负债/现金流报告。

发送真实请求前，Web需勾选将对话和必要结果发送至DeepSeek，API每轮检查 `consent===true`；未同意时不调用供应商或查询工具。只读身份不发送至模型；返回候选账户仅含别名、ID和类型，不含卡BIN/尾号/密码/令牌。模型能看到获准发送的短期聊天上下文、最近草稿状态、汇总、相关明细及备注。

## 无数据库联调

沙盒独立于 `app.js`，不加载 `.env`、初始化/迁移/定时任务，不连接真实数据库。只监听本机；提供明确的合成身份和临时模拟AES握手。默认模拟回答；用户在设置填入有效Key并应用后，调用真实DeepSeek，但工具仍读取合成账本。沙盒显式开启 `AI_ALLOW_SESSION_SETTINGS=true` 与开发专用 `AI_SYNTHETIC_DATA=true`，后者在生产无效，不能绕过真实数据库配置。**沙盒不验证生产鉴权与PIN链路**，不能部署为真实后端。

```powershell
# 终端一：D:\Code\live\api
npm run ai:sandbox
# 默认仅监听127.0.0.1:8866

# 终端二：D:\Code\live\web
$env:VITE_API_BASE_URL='http://127.0.0.1:8866'
npm run dev -- --host 127.0.0.1 --port 5176 --strictPort
```

访问 `http://127.0.0.1:5176/ai`。该Vite进程走模拟沙盒；不要在此地址验证其他业务页。恢复普通联调时移除本终端的 `VITE_API_BASE_URL` 环境覆盖并重启Vite。

也可在普通开发API中设置 `AI_MODE=mock` 测试正常鉴权链路；工具仍使用合成数据，但正式应用启动会执行现有初始化/定时逻辑，需自行使用测试库。生产环境禁止mock模式。

## 验证

```powershell
# API
npm run test:ai
# Web（依赖同级api目录及其现有依赖）
npm run test:ai
npm run build
```

自动测试覆盖工具伪造、身份参数注入、非法日期、越权账户、分类方向、调用限额、失败草稿隔离、草稿过期、只读事务失败及HTTP协议；新增连接白名单、Key用户隔离、有效期、过期连接拒绝、models检查与真实provider工具链替身测试。测试使用合成数据与数据库/供应商替身，**未证明真实MySQL授权、有效Key下的真实DeepSeek完整对话或完整金融账务正确性**。

原有普通写入的事务范围、日期/分类校验及幂等性仍需专项加固后，才能设计正式确认入账能力。本次仅修复借记/信用卡创建控制器中请求字段覆盖登录身份的问题。
