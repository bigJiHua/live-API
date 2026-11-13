# 2026-11-07 变更日志（合并）

> 本文件由当日独立日志按日期合并，来源见各节标题。

---

## 来源：CHANGELOG_2026-11-07_AI_CARD_GALLERY.md

# AI 提案卡陈列室与移动端调整

日期：2026-11-07（Asia/Shanghai）

## 范围与结果

针对 `/ai/cards-gallery` 补齐业务提案示例并改善手机操作。陈列室共 14 类、34 个示例、10 个场景；业务写入仍由原聊天页及真实接口处理，陈列室操作全部在内存中演示。

## 变更

- `web/src/views/AI/CardGallery.vue`：场景与类型筛选、可见数量、空结果提示、重置示例；返回与筛选控件扩大触控区域，底部兼容安全区。
- `web/src/views/AI/cardGalleryDemo.js`：独立本地数据及操作。补齐资产修改、删除、恢复、彻底删除，待补字段、失败终态、后台备份、超时恢复和长内容示例。示例 ID、版本与候选过现有提案合约校验。修正信用卡状态及新增资产仅预填原入口的规则。
- `web/src/components/ai/AiProposalCard.vue`：手机输入 16px，按钮至少 44px；收益编辑分行、长字段跨列、网格防溢出。修正 failed 终态、executed 有效期后的文案；备份紧凑卡显示回执及进行中/失败/成功图标，支持读取最新状态。基金紧凑卡补登记笔数和日期范围。操作结果不确定时锁住再次修改/执行，允许读取最新状态恢复。
- 组件新增可选 `operations` 回调供陈列室注入；未注入时仍调用现有真实 API。陈列室的新增资产入口改为只读预填示例弹窗，避免携带假 ID 跳真实业务页面。
- `web/src/utils/aiProposalDisplay.js`：补备份 processing/completed/unknown 文案。
- `web/tests/aiCardGallery.test.mjs`：新增 9 项本地状态、版本、合约及批量收益验证测试；未改已有 package.json 脚本。

## 验证

- `npm run build`：通过。现有大包及 Browserslist 数据更新提示仍在。
- `node --test tests/ai*.test.mjs`：87 / 87 通过，含新增 9 项。
- `node --test tests/ai*.test.mjs tests/uiSafety.test.mjs`：88 / 89 通过；失败项为既有登录页非演示模式留空校验。`src/views/Auth/Login.vue` 在开始本次工作时已被修改，且目前非演示分支有非空预填值；本次未编辑该文件或该测试，日志不记录其值。
- 浏览器使用同一 CardGallery 与 AiProposalCard 组件、Vant 及项目主题样式进行隔离预览；原路由需要登录，因此未修改认证守卫或使用真实业务数据。
- 320px / 390px 手机及 1024px 桌面宽度：页面 scrollWidth 等于视口宽度，长内容没有横向溢出；手机输入实测 16px、按钮实测至少 44px。
- 实际点击验证：补日期→保存→核对→二次确认→执行、超时后锁定→读取最新状态→继续核对、资产只读预填、详情展开、筛选空态、重置恢复。
- 深色与浅色布局已检查；临时预览 HTML 在验证后删除。

## 本地截图

- `temp/ai-cards-gallery-review/mobile-gallery-390.jpg`
- `temp/ai-cards-gallery-review/mobile-backup-390.jpg`
- `temp/ai-cards-gallery-review/mobile-long-320.jpg`

截图为同组件隔离预览，不是已登录真实账户的联调证明。移动端浏览器尺寸测试不包含实体 iPhone 键盘与安全区设备测试。

---

## 来源：CHANGELOG_2026-11-07_AI_FOLLOWUP_FIX.md

# 口语记账与支付续句修复（2026-11-07）

用户复现：「今天去赵一鸣买了 8.5的零食」→「余额支付的。」→「提案业务超出本次授权范围」。原错误由本站 API 的业务范围校验抛出，供应商已成功返回。原失败请求与耗时保留在 [诊断](AI_FOLLOWUP_SCOPE_DIAGNOSIS_2026-11-07.md)，不重放原失败请求。

## 变更

- 口语购物金额允许省略「元」，金额解析仍排除数量、日期、账户尾号、否定和特殊金融操作。
- 短句补充使用明确的 `sourceCandidateId`；只能修改同用户、同对话、未过期普通人民币候选的支付方式、账户或分类。金额、方向、币种、日期与备注保留来源。
- 补充始终返回同一张本地候选，供应商调用为零。补齐后使用既有本地草稿、核对和确认入账流程。
- 授权、候选更新、财务核查和对话记录在事务内衔接；并发补充不能混用字段与核验摘要，候选生成草稿后不能再次续写。
- 旧失败对话没有本地候选时先提示重核完整原记录，避免再发给供应商后被业务范围拒绝。
- 同时修复旧手工预检/草稿接口的跨会话来源绑定：A 对话候选不能配 B 对话生成，省略会话时仍使用原 A 会话；消费后的回放也保留原草稿链接。
- 自动生成草稿只保存助手卡片，不再把系统动作说明伪装为用户原话；明确提供的用户消息仍按原文保存。
- 页面错误对象保留 `traceId/httpStatus`，可与 API 脱敏日志对应。本地业务错误为 `phase=http`，供应商错误另有 `provider.error` 和审计 `phase=provider`。

## 验证

本轮证据目录为 `logs/ai-followup-fix-2026-11-07/`，结果如下：

| 层次 | 结果与证据 |
|---|---|
| 全量 API | 61 套、1257/1257：[最终结果](ai-followup-fix-2026-11-07/api-delivery-complete.json) |
| Web | AI 130/130、UI 2/2、金额6/6；生产构建成功，日志在证据目录 |
| 独立真实 HTTP/MySQL | 54/54，54 个独立合成身份与手工对话，全部有 traceId；54 份 SQL 加密来源摘要和 API 快照一致：[汇总](ai-followup-fix-2026-11-07/finance-review-final.json)、[读回](ai-followup-fix-2026-11-07/finance-readback-final.json) |
| 精确三句 | 原购物句→余额支付→微信账户和餐饮→本地草稿→核对→入账；该独立身份仅一条8.50支出，余额1000.00→991.50，跨进程重放仍同一回执 |
| 实际页面 | 新手工对话同一张候选更新、8.50入账、刷新和历史恢复同一回执；原失败对话显示重核入口，恢复至草稿、相似流水风险提示、取消后禁止续写：[SQL/API读回](ai-followup-fix-2026-11-07/ui-api-sql.json) |
| 移动视口 | 390×844，正文13px、行高20.15px、输入区88.4px、主要生成按钮44px；无横向溢出、无页面控制台错误：[实测尺寸](ai-followup-fix-2026-11-07/ui-mobile-metrics.json) |
| 历史原话 | 自动卡片只新增1条assistant；用户消息仅为实际两句原话，真实SQL与接口返回一致：[证据](ai-followup-fix-2026-11-07/history-action-sql.json) |
| 供应商与正式数据 | 本轮累计 provider 审计行76→76，新增调用0；正式26表的数量/SHA256不变：[核验](ai-followup-fix-2026-11-07/formal-after.json) |

首次失败证据均保留。独立财务首轮的两项断言修正分别为 MySQL 的8.5000与展示8.50采用十进制规范比较，以及限频失败UUID保留failed终态并通过GET源候选恢复赢家草稿。随后发现的跨会话缺口已实际修复并新增5项验证。Web测试替身已对齐真实候选store的consumed读取语义；旧API测试候选补齐真实会话fixture，继续验证原有特殊操作拒绝和唯一草稿回放，不放宽生产检查。

测试仅使用隔离库 `ai_fullscene_20261107_dcd7fbe5` 的合成身份与数据；API两进程7791/7792和验收Web5176已加载最终运行代码。正式 `live_dev` 的 26 张业务表与前轮及本轮开始基线一致，汇总SHA256为 `e8d777d6844a5fbfdf209f33b2c8036b96eb35a71af3d246f941d6c5117cf8ba`。本轮完整精确场景在两位独立财务身份各提交一条测试支出（首次业务已成功但字符串断言错误），实际浏览器另一手工对话提交一条测试支出；没有给正式用户入账。

## 适用范围

「余额支付」确定支付渠道，不能据此猜选微信或其它资金账户。多笔、改金额、改日期、已经结束的候选与 OCR 来源必须在对应卡片核对或重新提供完整原话。

原失败记录的恢复动作显示完整原话和日期，由用户点击重新核对；日期无法确认或已存在结束业务时仅提示重新完整输入，不自动拼接任意历史。OCR来源边界的新增测试使用明确标记的合成候选，并非重新执行真实OCR。真实手机与正式部署尚未验证；此前66场景证据与未验子项原样保留，没有宣称本轮重新调用模型跑完全部场景。

---

## 来源：CHANGELOG_2026-11-07_AI_FULLSCENE.md

# AI 规整与独立对话实际验收（2026-11-07）

已修复初审及实际调用暴露的问题，并逐项执行 **S2-001～S2-066 的核心场景**。每场景和修复复测均使用独立 manual 对话，保留首次失败、验收脚本误判和修复后的证据。完整分层验收仍有设备、页面跨午夜、生产发布等 pending 子项，不能把 API 回归通过等同于全部场景 verified。

本轮 **66行清单**、实际调用和每例剩余项见 [run-index.json](ai-fullscene-2026-11-07/run-index.json)。初审 [AI_REVIEW_2026-11-07.md](AI_REVIEW_2026-11-07.md) 与规划冻结证据未覆盖。源码摘要见 [source-manifest.json](ai-fullscene-2026-11-07/source-manifest.json)。

## 修复内容

| 范围 | 修复与最终行为 |
|---|---|
| 设置、授权、迁移 | 账号设置同时覆盖新旧 Key 槽位；设置/偏好恢复可等待、共享Promise、失败关闭；SQL成功后更新内存；022幂等补授权及供应商设置表 |
| 资金输入 | 尾号000不作金额；全角金额在解析和最终意图校验一致；多笔合计、模糊金额不静默拆分/丢笔；现金/余额与扣款账户冲突阻断，保留银行卡绑定微信/支付宝 |
| 多笔和单笔保存 | 全部提案先验证；草稿、候选消费、会话、加密恢复回执同事务；单笔模型结果也走统一原子保存；失败回滚，成功后丢响应可只读恢复 |
| 并发入账 | 两个实例确认同一draft/version只写一笔，双方返回同一唯一回执；事务内锁分类、账户、共享信用池并检查当前资金 |
| 取消和撤权 | SSE close传AbortSignal并留失败墓碑；晚到结果不写草稿/历史；模型等待、准备及事务末端复验授权，授权行锁使撤回与保存按事务排序 |
| 模型业务契约 | Prompt明确proposal.fields嵌套；缺备注null仅规范为空串；挂失卡用本人已授权卡片数据恢复；引号内名称不干扰外部操作意图 |
| 只读错误降级 | 历史查询两处异步return改await，真正SELECT权限失败能进入catch；资金仍可信，基线/重复核查明确unavailable |
| 页面恢复 | 多笔草稿/候选混合及历史恢复；切模型同步connectionId；迟到轮询不污染新会话；短范围、权限失败和过期重新核验；无协议HTTP错误保留状态码 |
| 时间和脱敏 | 专用保存时间先转合法ISO，缺失/非法为null，真实长号码仍脱敏；旧历史快照保留，新独立查询验证修复 |
| API诊断 | trace/context、供应商开始/等待/首包/完成/失败；保留HTTP/provider code、底层原因、耗时、SQLSTATE；Key/认证头/数据库密码/图片回显脱敏；中文分片不乱码 |

主要运行文件为 `src/modules/ai/api/index.js`、`service/index.js`、`businessService.js`、`businessIntent.js`、`transactionInput.js`、`financialWorkflow.js`、`financialRead.js`、`drafts.js`、`dataGrant.js`、`requestGuard.js`、`businessRead.js`、`diagnostics.js`、`deepseek.js`、`ocr.js`、`callLog.js`；共享资金规则在 `src/common/services/financialPreflight.js` 和 `accountPayment.js`。Web修改在AI页面/组件及 `utils/request/interceptors/response.js`。保留用户已有修改，未修改真实 `.env`，未重建或清理正式账本。

## 实际验证

- 最终 API **60套 / 1194项通过，0失败**：[JSON](ai-fullscene-2026-11-07/api-workspace-final.json)、[日志](ai-fullscene-2026-11-07/api-workspace-final.log)。Web AI **92/92**，金额 **6/6**、界面 **2/2**，最终Web构建退出 **0**：[构建日志](ai-fullscene-2026-11-07/web-final-build.log)。
- 财务50场景：**49个HTTP/真实数据库通过、1个安全拒绝（038）**。0.01、39.91、全角1000、1万元、1000000.01均有精确金额证据。[财务索引](ai-fullscene-2026-11-07/finance-results-index.json)。
- 两个真实应用进程、不同物理MySQL连接和行锁屏障：两笔700抢1000仅一笔成功，共享池和手工入口规则一致；同draft/version两方同一回执。[046复测](ai-fullscene-2026-11-07/results/S2-046.commit-idempotency-fix.json)。
- 预算、日记、4类todo动作、卡资料、4类固定资产安全动作、基金日值，**12类**完成真实模型与API/数据库创建、修改、核对、执行、取消、错误、版本测试。浏览器逐类查看独立历史终态卡；金融精密执行按范围拒绝。[业务汇总](ai-fullscene-2026-11-07/business-acceptance-summary.json)。
- 图表/表格用同一可信dataset：空余额保持空值，CNY/USD不合计，缺汇率与截断明确；旧历史只读，最后新独立查询已实际显示合法ISO保存时间。
- 隔离管理员备份：真实full/schema文件、大小/摘要、失败回执、重复同job、实际重启后不重跑；页面恢复已完成任务。[061恢复](ai-fullscene-2026-11-07/results/S2-061.recovery.json)、[重启](ai-fullscene-2026-11-07/results/S2-061.restart.json)。
- 真实浏览器socket中断：送达API前失败0调用；模型回应丢失仅GET恢复原请求；12.34入账回应丢失仅GET恢复相同回执，刷新后仍唯一流水。[058证据](ai-fullscene-2026-11-07/results/S2-058.ui-database.json)、[代理事件](ai-fullscene-2026-11-07/transport-proxy-events.json)。未用服务端timeout代替浏览器断连接。
- 本机MySQL透传代理真实收到COMMIT OK后丢弃数据库回应，草稿/正式入账均恢复唯一结果；不是模拟commit抛错。[052物理证据](ai-fullscene-2026-11-07/results/S2-052.commit-response-loss.json)。
- 受控故障供应商 **14次**，与商汤理解验收分列：超时、错JSON、tool、超提案数、SSE取消、晚到撤权、关闭能力、失败防重放及真实SQL权限故障。[生命周期汇总](ai-fullscene-2026-11-07/lifecycle-summary.json)。
- 最后新独立用户7.23：真实模型1次，单草稿+会话2消息+完成回执原子保存；跨进程恢复、取消终态正常，账本无支出。[正常路径](ai-fullscene-2026-11-07/single-release-candidate-final.json)。

实际截图与DOM在 `ai-fullscene-2026-11-07/ui/`，同时有 `S2-xxx.ui-database.json`。API动作不冒称为全部逐步骤UI动作通过。

## 当前供应商与API排查

供应商 **token.sensenova.cn / sensenova-6.8-flash**。DB审计本批真实调用 **53次**：51次供应商响应完成（应用契约失败另记），约 **3.3～21.0秒，平均6.9秒**；2次图片请求在约60秒超时。旧失败保留，新图片/新对话复测，不自动重放失败requestId，也未自动换Key、模型、URL。

文本超时为 `AI_PROVIDER_TIMEOUT`，OCR为 `AI_OCR_PROVIDER_TIMEOUT`。`AI_PROVIDER_TIMEOUT_MS` 默认 **60000**，支持1000～105000；OCR与业务外层截止时间加15秒，上限120秒。验收进程使用 **90000**，真实 `.env` 未改。新图片和浏览器成功图通常约6秒返回；延长截止时间不代表供应商变快。

控制台每行 `[AI]` JSON，响应头有 `X-AI-Trace-Id`。按traceId/requestId/conversationId定位，查 `provider.start / waiting / first_byte / done / error`、`guard.error`。含供应商、模型、endpoint、timeoutMs、elapsedMs、firstByteMs、HTTP/provider状态、providerCode/message、causeCode、SQLSTATE/errno。非流式OCR不能观察首包时保持 `firstByteMs=null`。

DB `ai_call_log` 分provider/preview/gate/tool/commit审计，`ai_request_run` 保存每request的provider_calls、状态及加密恢复回执；接口失败和供应商失败分开定位。实际60秒超时见 `ai-fullscene-2026-11-07/api-server-reloaded.log`，最后版本日志见 [api-server-final-timestamps.log](ai-fullscene-2026-11-07/api-server-final-timestamps.log)，本轮清单保存供应商耗时汇总。

## 数据与隐私

隔离库 `ai_fullscene_20261107_dcd7fbe5`，只复制DDL、使用合成用户/账户/流水。成功业务提交及备份仅此库和独立runtime目录。021/022迁移各真实运行两次，幂等通过。正式 `live_dev` 仅只读核验，**26表行数和SHA与开始时完全相同**，保留原0.01流水。[最终摘要](ai-fullscene-2026-11-07/formal-final.json)。

本轮文本证据与232条审计行扫描：真实凭据命中 **0**、图片字节命中 **0**；实际移除/完成后DOM图片引用0，历史仅识别字段。[隐私结果](ai-fullscene-2026-11-07/privacy-final.json)。`ocr-fixtures/` 原始PNG是明确合成输入证据，主动保留；应用不保存原图。

故障7793、供应商stub、MySQL代理已停止；临时测试只读账号/触发器/截断样本清理完成。058临时7794/5177已关闭。保留7791/7792隔离应用与5176页面供查看，未停止用户原5173服务。

## 未齐的独立证据层

- 真实手机、屏幕阅读器硬件；390px响应式检查不能替代真实设备。
- 页面真实跨上海午夜；受控时钟+真实MySQL已验23:59:59/00:00:01 default锚点及manual分离，不冒称浏览器真实跨天。
- 自然InnoDB死锁、提交前KILL；额外等待定位未达到前提，保留failed探测且未KILL用户连接。已完成真实COMMIT回应丢失、SQL失败/回滚和物理竞争。
- S2-017未匹配信用分组物理造例；图片错误/登出/卸载、权限变化的全部UI变体、其它业务每个动作的全部逐步骤UI，见66行清单和生命周期remaining。
- 真实生产部署、灰度、关闭演练；本轮隔离开关/模型处理中关闭已验，`released=false`。

结论：**66个核心场景已执行，主要流程与已修问题复测通过；完整分层验收仍有上述pending子项**，不标“全部verified”。

---

## 来源：CHANGELOG_2026-11-07_AI_RELIABILITY.md

# AI 取消、慢网络与诊断边界（2026-11-07）

本轮可靠性复查确认：OCR 离页没有向后端传播取消；OCR 候选和会话分开保存；流式读取没有客户端总时限；审计写入失败缺少请求上下文；前端部分 HTTP 错误丢失链路编号。已按授权修复，未调用真实付费模型，正式业务库保持只读。

## 改动

- `/ocr` 与旧 `/chat` 在响应连接提前关闭时传播 AbortSignal。守卫返回 `499 / AI_REQUEST_CANCELLED`，保留已使用的供应商预算和不可重放的请求编号。
- OCR 候选、会话与加密恢复回执同事务保存；取消、会话或恢复写入失败回滚。事务提交回应或外层完成回应丢失后，GET 恢复已提交的结果及候选当前终态；恢复不再次识别。
- 流式请求使用同一个 120 秒总时限覆盖客户端上下文、共享握手、fetch、JSON 与逐帧读取，合并手动取消；超时返回 `AI_STREAM_TIMEOUT`，结束等待后只读取回执。有效 done 会清理计时器与取消监听。
- 审计保存的同步、异步错误统一记录脱敏请求/阶段/SQL 错误码，不记录请求载荷、SQL 文本或数据库错误回显；文案不再宣称审计必然写入成功。
- 前端只从正文和白名单响应头读取 traceId/requestId，并保留实际 httpStatus；不复制 Authorization、Cookie 或 API Key 头。普通 Axios fulfilled 错误路径也保留响应上下文。

## 验证

- [API 专项结果](ai-fullscene-2026-11-07/reliability-ocr-transaction-final.json)：8 套、122 项通过，包含实际本地 HTTP 断开、迟到 OCR 结果、候选保存中取消、会话/恢复失败回滚、完成回应丢失与回执过期不可重放。
- [审计专项结果](ai-fullscene-2026-11-07/reliability-audit-diagnostics.json)：8 项通过，含同步与异步写入失败的关联信息与隐私检查。
- [Web 诊断与业务结果](ai-fullscene-2026-11-07/reliability-http-diagnostics.log)：55 项通过；[OCR HTTP 契约](ai-fullscene-2026-11-07/reliability-web-ocr-contract.log)：24 项通过。
- [流式总时限结果](ai-fullscene-2026-11-07/stream-deadline-focused-1794041032461.json)：16 项通过，含六阶段停滞、累计时限、迟到准备结果、手动停止、done 后连接不关闭与计时器/监听清理。
- [真实 SQL 故障结果](ai-fullscene-2026-11-07/ocr-cancel-integrity.remaining.json)：后端独立复测确认候选 INSERT 等待中取消回滚、事务 COMMIT 回应丢失及外层完成回应丢失恢复。首次供应商等待中取消已通过；首次定位器未捕获 SQL 等待的失败证据另保留。总计 5 次本地故障供应商调用，真实商汤调用 0。

完整 API/Web 回归、服务重载及浏览器视觉复核由主流程在全部源码完成后统一执行；专项通过不替代这些层面的最终结果。

---

## 来源：CHANGELOG_2026-11-07_AI_UI_REFINEMENT.md

# AI 移动端规整与最终可靠性复核（2026-11-07）

本轮继续完成用户要求的移动端字号/间距调整，同时修复复核中新发现的金额可信口径、OCR 取消保存与慢连接排查问题。当前源码已通过最终回归，并在真实隔离 API、MySQL 和浏览器中复查。此日志补充此前 [66 个独立对话核心场景实测](CHANGELOG_2026-11-07_AI_FULLSCENE.md)，不覆盖冻结证据，也不把响应式浏览器当作真实手机或生产发布。

## 页面调整

| 手机端项目 | 调整前 | 当前实际观察 |
|---|---|---|
| 消息正文字号 | 15px | 13px |
| 正文行高 | 25.5px | 20.15px |
| 消息间距 | 14px | 10px |
| 输入区高度 | 约 111.4px | 88.4px |
| 输入字号 | 保留防 iOS 放大要求 | 16px |
| 草稿主要操作触控高度 | 保留操作可用性 | 44px |

360×800、390×844 与 1280×900 均已观察；页面 scrollWidth 与 viewportWidth 相同。360px 下草稿外宽约 314px、内宽 312px，主要按钮 44px。金额、风险、来源时间和回执不截断；数据表允许在自己的容器中横向查看。桌面正文保留 14px。窗口验收结束后已恢复默认尺寸。

Assistant 欢迎说明、头像、标题、消息间距、输入栏和 Markdown 间距已收紧。Draft / FinancialCheck / Proposal / Dataset / Preview / Ocr 六类卡片使用统一字号/间距变量；Evidence、授权、设置、日志抽屉及陈列页同步规整。授权弹窗补明确关闭按钮。设置明确数据发送至当前供应商、Key 保存方式和日志入口；商汤不提供用量余额查询时显示正常能力说明，无失败弹窗，不与账本余额混淆。

实际浏览器复查：独立 manual 对话中补账户/分类/支付方式 → 本地风险核验 → 生成 39.91 元草稿 → 历史恢复 → 编辑表单 → 核验过期阻止核对 → 重新核验 → 风险确认 → 核对 → 取消。最终为已取消、未入账。另查看余额历史的折叠限制、图表、7 行数据及来源时间；陈列页 13 类终态卡和连续长字符串在 360px 下不撑出页面。陈列页仅是本地视觉验证，真实业务理解/API/数据库证据仍见此前 66 场景报告。

截图与实际 DOM：

- [360px 最终草稿](ai-ui-refinement-2026-11-07/mobile-draft-final-360.png)、[草稿 DOM](ai-ui-refinement-2026-11-07/mobile-draft-final-360.dom.txt)、[取消 DOM](ai-ui-refinement-2026-11-07/mobile-cancelled-final-360.dom.txt)。截图在取消之前，后续取消终态另存，不表示当前仍可提交。
- [编辑表单](ai-ui-refinement-2026-11-07/mobile-draft-edit-final-360.png)、[缺字段候选](ai-ui-refinement-2026-11-07/mobile-candidate-390.png)、[360px 风险提示](ai-ui-refinement-2026-11-07/mobile-warning-360.png)。
- [最终授权](ai-ui-refinement-2026-11-07/mobile-auth-final-390.png)、[最终设置](ai-ui-refinement-2026-11-07/mobile-settings-final-390.png)、[数据表与限制 DOM](ai-ui-refinement-2026-11-07/mobile-dataset-final-390.dom.txt)。
- [业务紧凑卡](ai-ui-refinement-2026-11-07/mobile-business-compact-360.png)、[长内容](ai-ui-refinement-2026-11-07/mobile-business-long-360.png)、[1280px 桌面](ai-ui-refinement-2026-11-07/desktop-final-1280.png)、[实际尺寸记录](ai-ui-refinement-2026-11-07/viewport-metrics-final.json)。

## 真实可信与可靠性修复

- 缺失/非法币种不再默认为 CNY；缺失、零、负汇率不能进入已核实金额。合法 CNY 和合法外币冻结汇率保留精确计算；只有未计价记录时对应金额为 null，真正空集合为 0。新增 unpricedCount/incomplete，兼顾 v2 finance/card 与 legacy 查询。实际隔离新用户 14 条记录、真实 API preview 和只读 SQL 校验通过，原始记录 SHA 未变，供应商调用 0：[币种口径证据](ai-fullscene-2026-11-07/currency-query-integrity.completed.json)。
- Dataset 收起时仍显示未计价、未提供金额、未知币种、多币种和截取限制；已知汇总币种才显示“已计入”金额。来源时间保留，不推算汇率或从原币行猜汇总币种。实际 Vue 渲染回归 9 项通过：[最终证据](ai-fullscene-2026-11-07/dataset-trust-final-focused-1794040557121.json)。
- OCR 与 legacy 请求增加停止/离页取消传播，忽略迟到结果。OCR 候选、会话、加密恢复回执同事务保存；取消在 INSERT 等待中到达会回滚，提交回应丢失恢复已保存结果。原 UUID 不重复调用供应商。真实本机供应商等待取消、MySQL INSERT 等待取消、事务 COMMIT 回应丢失、外层完成 UPDATE 回应丢失均复查通过：[物理汇总](ai-fullscene-2026-11-07/ocr-cancel-integrity.summary.json)。故障供应商 5 次，与真实视觉理解验收分列；首轮测试定位失败保留。
- 流式请求增加 120 秒全链路时限，覆盖上下文、握手、fetch、JSON 和 reader；手动取消仍是 AbortError，超时转同 UUID 的 GET 回执，正常 done 清计时器。无新增付费自动重试：[16 项验证](ai-fullscene-2026-11-07/stream-deadline-focused-1794041032461.json)。
- 取消文案改为“已请求停止，正在读取最终回执”，最终取消回执明示已取消；不再承诺后台必定继续完成。正常停止不误报网络异常。
- API 审计写失败打印脱敏 requestId/traceId/lane/phase/SQL code；不打印 payload 或原始 SQL 错误文本。普通 HTTP 错误保留真实状态和白名单链路编号；跨域暴露 X-AI-Trace-Id。原 provider.start/waiting/first_byte/done/error 耗时诊断保留，便于区分供应商慢、网络、解析、门控与数据库失败。详见 [可靠性专项日记](CHANGELOG_2026-11-07_AI_RELIABILITY.md)。

## 最终验证与运行状态

| 检查 | 最终结果 | 证据 |
|---|---|---|
| 全 API | 60 套 / 1206 项，0 失败、0 pending | [JSON](ai-ui-refinement-2026-11-07/api-final.json)、[日志](ai-ui-refinement-2026-11-07/api-final.log) |
| Web AI | 121 / 121 | [日志](ai-ui-refinement-2026-11-07/web-ai-final.log) |
| Web 金额 | 6 / 6 | [日志](ai-ui-refinement-2026-11-07/web-money-final.log) |
| Web 界面安全 | 2 / 2 | [日志](ai-ui-refinement-2026-11-07/web-ui-final.log) |
| Web 构建 | 退出 0 | [日志](ai-ui-refinement-2026-11-07/web-build-final.log) |
| 重启后两 API 实例 | 8 次只读回执核验：取消/恢复/当前 discarded 状态正确，traceId 可读；0 在途、provider 审计数量不增加；CORS 正确 | [JSON](ai-ui-refinement-2026-11-07/api-runtime-final.json) |

当前仍使用 token.sensenova.cn / sensenova-6.8-flash；本轮修复新增真实商汤调用 0。此前真实 53 次调用中 51 次供应商完成约 3.3～21 秒、平均约 6.9 秒，2 次 OCR 60 秒超时的原始失败仍保留。未更换 Key、模型或 URL；本轮超时保护和诊断不代表供应商速度变快。真实 .env 未改，默认供应商时限 60 秒，验收进程仍使用 90 秒。

正式 live_dev 26 张表的数量/SHA 不变，最终摘要 e8d777d6844a5fbfdf209f33b2c8036b96eb35a71af3d246f941d6c5117cf8ba。本轮新的 5 份故障证据与 21 个 DB payload，真实凭据/原图命中 0；控制触发器残留 0。测试仅使用隔离库 ai_fullscene_20261107_dcd7fbe5 和合成数据。7793 故障服务已释放；7791/7792 已安全重载，5176 保留验收页面，原 5173 服务保留。

真实手机、屏幕阅读器硬件、真实跨上海午夜、自然死锁/提交前 KILL、S2-017 未匹配信用分组物理造例、生产部署及全部动作的严格逐步 UI 子项仍沿用此前报告的未验边界。API 1206 项通过不等于这些证据层已 verified。核心 66 场景的原独立对话结果及剩余项见原 [run-index](ai-fullscene-2026-11-07/run-index.json)。

---

## 来源：CHANGELOG_2026-11-07_AI_V3.md

# 2026-11-07 V3 改版与验收

负责人明确授权：重新规划，屏蔽 V1/V2 聊天线路，交付 AI 自主理解原话、按需调用既有数据能力、归类并生成最终人工确认入库草稿的 V3。此前“防循环=单次调用+本地意图解析”的实现决定被此指令替代。

实施计划：[V3 计划](../../Docs/docs/ai/PLAN/v3/README.md)。本次沿用既有草稿、授权、随机引用、独立只读池、事务与幂等执行器；不覆盖既有修改、不改变 `.env`、不向正式库写验收业务。

实施启动时（历史记录）：后端、前端与独立验收并行实施。新增持久 `v3-chat` 请求预算、每轮最多5次模型、每日调用配额和V3事务回执恢复；HTTP路由停用旧聊天并注册V3。该阶段尚未实际验收，最终结果见下文。

早期局部验证：请求预算、历史请求防护、供应商错误边界及脱敏日志共4套44项通过。该数量不代表 V3 工具编排或真实供应商全场景通过。

## 最终交付与真实验收

V3 原话主流程已实现并完成本地隔离验收。AI 决定意图、分类与需要的工具，API 固定只读 SQL 和可撤回授权门控，工具结果回灌后统一 JSON 收尾。草稿先存档、人工核对确认后才入库。旧聊天与 V2 入口返回410。代码未部署生产，.env未改。

- 真实 SenseNova / sensenova-6.8-flash / HTTP / MySQL：27个场景最终27通过、0未解决；100次独立身份与独立manual聊天，保留35次历史失败。
- 调用：验收320、协议探针2、UI50，合计372。不是金额成本，未配置供应商定价。
- 最后源码7个受影响场景单独复测；与引用/协议核心相比仅v3Service方向标量及v3Claims只读措辞精度有变化。其余核心与历史通过场景来源均在JSON标明，不伪称全部100次尝试来自最后源码。
- API 43套1062/1062，金额176/176；独立184/184（与API重叠）；Web AI106/106、money6/6、build成功。通用UI登录断言1/2，既有用户修改保留。
- 移动端：原句→余额支付→微信账户/餐饮，真实8.50元草稿、人工核对、确认、SQL新增1笔、重复确认幂等、刷新0额外模型调用。正式26表SHA前后完全相同。
- 最后源码HTTP 10个文字请求：P50 18.0秒，P95 33.7秒；没有声称供应商变快。API记录requestId/traceId、等待/供应商状态及脱敏错误；模型参数/JSON/引用/DB失败能区分。

评测覆盖普通收支、自动分类、歧义/缺项、生活提案、10域只读、注入/权限、资金不足、请求重放、中文/全角金额及查询后续记账。实际备份文件、物理手机、生产压测/熔断、CI门禁、供应商strict schema和货币成本核算未在本轮完成。有限声明校验不证明任意模型措辞；实际卡片、数据来源和入账回执为准。

完整证据：[verification-summary-final.json](ai-v3-2026-11-07/verification-summary-final.json)、[独立源/SQL读回](ai-v3-2026-11-07/final-independent-evidence.json)、[UI读回](ai-v3-2026-11-07/ui-final.json)、[安全复核](ai-v3-2026-11-07/SECURITY_REVIEW.md)。

![390px移动端真实入账回执](ai-v3-2026-11-07/ui-final-mobile.jpg)

最终修复：SenseNova工具阶段与JSON输出分开；本轮批准ref回灌保留；中文/全角/金额与跨天日期证据；候选截断/账户歧义；无实际成果的明确完成声明同事务拒绝；精确direction字符串0/1规范化，绝不按本地正则理解原话。每轮5模型/8工具/120秒、默认每人每日100调用；隔离验收聚合预算120→180→260→320→360仅用于追加复测，不修改生产配额。
