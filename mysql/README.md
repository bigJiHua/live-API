# MySQL 数据库

本目录包含数据库相关的 SQL 文件和表结构说明。

## 文件说明

### live.sql
**完整的数据库表结构**
### live_old_version.sql
**旧的的数据库表结构**
### live_V1.0.0.sql
**完整的V1.0.0版本数据库表结构，只适配V1.0.0版本！**

`live.sql` 共 **35 张表**：

| 表名 | 说明 |
|------|------|
| `user_info` | 用户信息表 |
| `user_log` | 用户登录日志表 |
| `account` | 记账明细表 |
| `account_balance` | 账户余额表 |
| `account_transfer` | 转账记录表 |
| `ai_conversation` | AI 会话元数据表 |
| `ai_message` | AI 聊天消息与查询/识别依据表 |
| `ai_chat_activity` | 加密原话与排队/执行/终态，供同账号跨设备聊天只读同步 |
| `ai_analysis_preview` | 加密范围授权快照、随机引用与单次消费记录 |
| `ai_business_proposal` | 独立业务提案、核对版本与执行回执 |
| `ai_background_job` | 人工确认后的固定系统备份任务 |
| `ai_request_run` | 持久请求去重、供应商调用预算与加密回执 |
| `ai_request_lane` | 跨进程用户并发锁与分钟限流 |
| `ai_transaction_candidate` | 交易补充候选、加密来源和单次草稿消费记录 |
| `asset_register` | 资产登记表 |
| `asset_snapshot` | 资产快照表 |
| `budget` | 预算控制表 |
| `bus_ai_draft` | AI 记账草稿与人工入账回执表 |
| `bus_category` | 分类字典表 |
| `bus_fund_history` | 理财净值历史表 |
| `bus_recurring` | 周期性计划任务表 |
| `card_base` | 卡片基础信息表 |
| `card_bill` | 卡片额度账单表 |
| `card_credit_pool` | 信用卡共享额度池表 |
| `card_foreign_register` | 外币消费登记与对账表 |
| `card_log` | 卡片操作日志表 |
| `card_repay` | 信用卡还款记录表 |
| `device_crypto` | 设备密钥表 |
| `fixed_asset` | 固定资产表 |
| `fund` | 理财产品表 |
| `moment` | 动态/日记表 |
| `security_verify_log` | 安全验证日志表 |
| `sys_attachment` | 文件附件索引表 |
| `todo` | 待办事项表 |
| `work_job` | 工作信息表 |
| `work_salary` | 工作薪酬核算表 |

> `_migrations` 表由 `migrationRunner` 运行时自动创建，不在 `live.sql` 中。

---

## 表结构约定

所有表结构以 `live.sql` 为准，业务表通用规范：

- 主键 `id`：`varchar(50)`，通过 `nanoid` 生成业务 ID
- 外键/关联字段：`varchar(50)`
- 时间字段：`varchar(20)` 存储时间戳字符串
- 软删除：`is_deleted` tinyint(4) DEFAULT 0
- 字符集：`utf8mb4`，排序规则 `utf8mb4_unicode_ci`
- 行格式：`ROW_FORMAT=DYNAMIC`（避免 utf8mb4 索引超限）

详细建表语句请直接查看 `live.sql` 文件。

AI 持久化表沿用当前实现的独立结构：草稿/会话主键为 `CHAR(36)` UUID，消息主键为自增 `BIGINT`；业务关联字段为 `VARCHAR(64)`，日期与审计时间使用 `DATE` / `DATETIME`，过期时间为毫秒 `BIGINT`，状态使用 `ENUM`、结构化证据使用 `JSON`。三表指定 `utf8mb4` 与 `ROW_FORMAT=DYNAMIC`，排序规则沿用 MySQL 的 utf8mb4 默认值。018 仅补齐建表迁移，不转换已存在表的列类型或排序规则。含 `JSON` 的 AI 表要求 MySQL 5.7.8+。

---

## 迁移脚本

`migrations/` 目录下存放增量迁移脚本，按编号顺序执行：

| 脚本 | 说明 |
|------|------|
| `001_alter_account.sql` | account 表新增 `transfer_group_id`、`reversed_id` 字段及索引 |
| `002_alter_bus_fund_history.sql` | bus_fund_history 表 `fund_id`/`id` 改为 varchar(50) |
| `003_alter_fund.sql` | fund 表 `user_id`/`id` 改为 varchar(50)，新增 `invest` 投入本金字段 |
| `004_alter_bus_recurring.sql` | bus_recurring 表补齐 `remind_days`/`remark`/`month_records`/`update_time`/`is_deleted` |
| `005_alter_id_varchar50.sql` | 18 张表 id 字段统一从 varchar(32) 加长为 varchar(50) |
| `006_alter_moment_visible_type.sql` | moment 表 `visible_type` tinyint(4)→varchar(255) JSON + `_migrations` 表补齐 ROW_FORMAT=DYNAMIC |
| `007_alter_decimal_precision.sql` | account.amount 与 card_bill 的已用额度/账单/待还金额改为 decimal(14,4) |
| `008_add_password_changed_at.sql` | user_info 新增密码修改时间戳并初始化，用于 Token 吊销 |
| `009_credit_pool.sql` | card_base 补充 `share_pool_id` 列 + 新建 `card_credit_pool` 共享额度池表（信用卡重构补充结构） |
| `010_card_bill_columns.sql` | card_bill 补充 `bill_day` / `repay_day` 冗余列（CreditCore.syncCardBills 写入所需） |
| `011_card_foreign_register.sql` | 新建 `card_foreign_register` 外币消费登记/对账表（痛点4，此前仅靠运行时自愈，现改严格迁移） |
| `012_card_bill_create_time.sql` | card_bill 补充 `create_time` 列（CreditCore.syncCardBills INSERT 写入所需） |
| `013_card_repay_repay_card_id.sql` | card_repay.repay_card_id varchar(20)→varchar(50) |
| `014_card_foreign_register_unique.sql` | card_foreign_register 新增唯一键 `uk_account_id`（防重复登记） |
| `015_card_repay_account_id_nullable.sql` | card_repay.account_id 允许 NULL（本卡还款） |
| `016_credit_pool_credit_report_merged.sql` | card_credit_pool 新增 `credit_report_merged` 信报合一标记（开启后支持合并还款） |
| `017_consolidated_20261018.sql` | 合并原 017/018/20261013：device_crypto.aes_key varchar(64)→varchar(191) + work_salary/bus_fund_history 唯一键（含自动清重）+ sys_attachment.file_hash |
| `018_ai_persistence.sql` | 新建 bus_ai_draft / ai_conversation / ai_message，包含草稿版本、入账回执、查询与 OCR 溯源字段；不插入样例或正式账务数据 |
| `019_consolidated_20261111.sql` | 合并原 019~025：AI 工作区五表、交易候选、调用审计/用户偏好（phase 放宽至 32）、授权与加密接入商设置、多接入商配置、跨设备聊天活动；会话增加 default/manual 每日唯一锚点；只增 AI 结构，不重算或清理正式业务 |

> 以上迁移变更均已合入 `live.sql`，新环境直接导入 `live.sql` 即可。迁移脚本对已升级环境为幂等（重复执行自动跳过）。
>
> **2026-10-18**：原 `018_work_fund_unique_keys.sql`、`20261013_add_sys_attachment_file_hash.sql` 已合并进 `017_consolidated_20261018.sql`。
> 原因是后两个文件名不符合 `001~017` 的连续编号，而迁移器只按文件名 `.sort()` 执行 —— 以后再新增 `019_` 会排到它们之前。
> 合并后的 017 是新文件名，已执行过旧 017 的库会重跑一次；三条语句均幂等（MODIFY / 清重 DELETE / 已存在则跳过），无副作用。
>
> **2026-11-11**：原 `019_ai_business_workspace.sql` ~ `025_ai_call_log_phase_width.sql` 已合并进 `019_consolidated_20261111.sql`，编号恢复连续。
> 已执行过旧 019~025 的库会重跑一次合并脚本；CREATE IF NOT EXISTS、重复列/索引跳过、MODIFY 扩列、搬迁 INSERT IGNORE 均幂等，旧 `_migrations` 记录可保留。

### AI 表升级（018）

- 新环境的完整建库源为 `live.sql`，其中已包含三个 AI 表；这些定义位于字符集恢复语句之前。
- 已有环境通过正常 API 启动初始化流程执行未登记的 `018_ai_persistence.sql`（默认增量模式，`INIT_SKIP` 不应开启）。`_migrations` 由迁移运行器在三条语句全部成功后登记。
- 三条语句均为 `CREATE TABLE IF NOT EXISTS`：表已存在则保留结构和数据；中途失败后可以重跑。它不会修复同名表的缺列或结构差异，遇到此类情况应另写下一编号的增量脚本。
- 018 只创建 AI 表，不改变正式流水、余额、信用卡账单，也不回填聊天或 OCR 样例。不要在已有库直接导入包含 `DROP TABLE` 的完整 `live.sql`。
- 编号接在当前 017 之后，文件名区别于已合并删除的旧 `018_work_fund_unique_keys.sql`；旧迁移登记记录可继续保留。

补齐过程与隔离验证见 [当日合并日志·迁移一节](../logs/CHANGELOG_2026-11-06.md)。

### 用户额度与超时升级（020，2026-11-13）

`020_ai_user_budget_settings.sql` 初始化 `ai_config` 五项站点默认值，输出列支持 `max`，并在 `ai_user_preference` 增加五项本人覆盖。用户通过「聊天设置 → 额度与超时」提高本人额度，不写入全站配置。保留现有非空值及思考/联网偏好；不修改账务表。

正常启动自动执行。跳过启动迁移的环境可运行 `node tools/ai-budget-settings-migrate.js <明确数据库名>`，只应用此项迁移并登记 `_migrations`。完整建库定义和初始行见 `live.sql`。

### AI 业务工作区升级（019）

- 正常启动迁移器按编号执行 019；表使用 `CREATE TABLE IF NOT EXISTS`，重复会话列/唯一索引按已有运行器规则跳过。JSON 列要求 MySQL 5.7.8+。
- 已有环境只需本次 AI 升级时，可执行 `npm run ai:business:migrate`：固定运行 019 合并脚本（原 019~025 全部 AI 结构），不调度旧迁移，不启动账务定时任务；执行前后核对正式表摘要，并登记 `_migrations`。
- 全量 `live.sql` 已合入上述 AI 表及每日会话字段。已有库不可通过导入全量建库 SQL 升级。
- `AI_BUSINESS_ENABLED=false` 关闭新增能力；生产需显式启用，并用 `AI_BUSINESS_DOMAINS` / `AI_BUSINESS_ACTIONS` 的固定白名单分域开放。只读权限工具仅给 18 个业务表 SELECT（含资金核验所需 `card_foreign_register`），认证和密钥相关表继续拒绝读取。
- 预览/请求结果加密，图片不进入表；请求到期清理结果内容并保留请求编号墓碑，重复编号永远不会再次调用供应商。正式写入仅从已核对提案的 ID 和版本读取。

实施与真实回滚验收见 [AI 业务实施日志](../logs/CHANGELOG_2026-11-06_AI_BUSINESS_IMPLEMENTATION.md)。

### 交易候选与财务预检升级（020）

- `019_consolidated_20261111.sql` 中的原 020 部分按连续编号执行，只使用 `CREATE TABLE IF NOT EXISTS` 新建 `ai_transaction_candidate`。与 `live.sql` 的定义完全一致；已有库通过增量脚本升级，不可全量导入 `live.sql`。
- 候选采用 `VARCHAR(50)` 主键、`VARCHAR(20)` 来源、毫秒 `BIGINT` 时间、软状态以及 `utf8mb4_unicode_ci` / `ROW_FORMAT=DYNAMIC`。原话、字段和 OCR 短证据使用应用加密的 JSON 文本，不保存图片字节、API Key 或余额初始化数据。
- 候选与可核对草稿分别存储。缺少字段、资金不足、来源异常时保留待补充候选；核验通过后，在同一事务内将候选消费为一个草稿。本人范围内请求编号和图片来源摘要唯一，取消/失败/过期墓碑不能自动重建为第二笔草稿。
- 只运行本次升级可执行 `node tools/ai-financial-migrate.js`：固定执行 019 合并脚本、登记 `_migrations`，执行前后比较正式表行数与 SHA-256 摘要，并重复 CREATE 验证幂等。不启动应用、旧迁移、余额重建、信用卡对账或定时任务。
- `node tools/ai-business-read-grants.js` 的白名单只增加 `card_foreign_register` 的静态 SELECT，共 18 个业务表；不增加任何通配或写权限。这个部署步骤与 019 结构升级分别执行。
- 一次性隔离库验收脚本 `ai-financial-isolated-verify.js` 已移至本地 `../temp/api-tools-oneoff/`，不随仓库发布；其隔离要求不变：仅在新建的 `ai_s2_verify_YYYYMMDD_随机值` 隔离库里写合成验收资金与草稿，拒绝默认业务池和供应商调用，核对正式表摘要。隔离库会保留并在验收证据中标明，便于继续界面验收；不能把隔离数据导回真实账本。

规划和验收口径见 [下一阶段实施计划](../../Docs/docs/ai/PLAN/next-stage/implementation-plan.md)。

---

## 更新日志

### 2026-11-10
- 新增 `024_ai_chat_activity.sql`，与 `live.sql` 定义一致。
- 专项升级执行 `npm run ai:chat-sync:migrate`，仅创建活动表并登记 `_migrations`，重复执行幂等；不调用完整迁移器或账务任务。
- 原话按字段加密，`execution_token` 只供执行端 CAS 更新，不在同步响应中返回。GET 状态读取使用本人会话范围，不触发模型或写入。

### 2026-11-06
- 补齐 AI 草稿/会话/消息的 `018_ai_persistence.sql`，与完整建库定义一致。
- 更新实际 29 张表清单，补充遗漏的 007/008 迁移说明及 AI 升级边界。

### 2026-06-30
- 修正表列表，移除不存在的 `asset`/`app_config`/`login_log`，补充 `asset_register`/`asset_snapshot`/`account_balance`/`work_job`/`user_log`
- 移除过时的 SQL 示例（旧 INT/VARCHAR(32) 格式），改用以 `live.sql` 为准的结构约定

### 5月28日
- 更新 `live.sql` 核心表结构，统一主键和外键 `varchar` 字段长度为 50。
- 新增多张业务表（`fund`、`bus_fund_history`、`bus_recurring`、`account_transfer`、`device_crypto`、`security_verify_log` 等），共计 24 张表。
