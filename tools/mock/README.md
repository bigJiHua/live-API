# 三年单用户数据库生成器

以当前 `mysql/live.sql` 和实际业务计算口径创建独立 MySQL 数据库。默认从运行当天的三年前同日开始，按上海时间包含首尾两日。固定日期和 seed 可重复生成相同数据。

本次数据库为 `live_mock_20261112`，范围 **2023-11-12—2026-11-12**。保留 26 张非 AI 表的 13,038 条生活和账务记录及全部 42 张表结构、`_migrations` 表。AI 会话、消息、草稿与运行记录已清空，原库的 5 个 AI 接入商配置、1 条兼容连接配置和用户偏好已迁到 mock 账号，地址、模型和 Key 保留。

当前 API 实例已连接该 mock 库，运行端口 **7788**。账号 `mock_life`，密码 `MockLive2026!`，PIN `246810`。当前前端可直接使用该账号测试。下面的生成命令用于另建新库；生成器默认保留 AI 结构并让 AI 数据为空。

在 API 目录运行：

```powershell
# 默认仅导出；建库需要 --create，库名只能为全新 live_mock_*。
npm run mock:db -- --create --database live_mock_new --end 2026-11-12 --seed live-three-years-v1

# 从原生成清单恢复范围和种子，日后执行不会改变日期基准。
npm run mock:db:verify -- --database live_mock_20261112

# 可选启动独立 API（端口 7792）；前端需指向该端口。
npm run mock:db:serve -- --output "D:/Code/live/temp/mock-databases/live_mock_20261112"
```

输出默认位于 `D:/Code/live/temp/mock-databases/<数据库名>/`，也可用 `--output` 指定新的空目录。包含 `database.sql`、`dataset.json`、`manifest.json`、`.env.mock`、真实占位 PNG 和使用说明。校验自定义目录时同时传 `--output`；若原清单丢失，需要提供原始 `--start --end --seed`。

SQL 导入和程序建库都在目标库已存在时失败；不会清空或复用含业务数据的库。建库连接读取 API 的 `DB_*` 配置，但写入目标必须是新的 `live_mock_*`，不改 `.env`。只读 `verify` 可以检查已被当前 API 连接的 mock 库。附件落在新的 `public/uploads/mock/<seed摘要>/`。

数据口径：

- 每天的现金类余额从区间期初收入和有效流水推导，转账双流水配对，还款扣款与账单相符，外币采用每 100 外币兑换人民币的汇率。
- 信用卡账单日期使用当前 `CardBill` 计算方法，共享池额度按池计算；建库后用实际 `CreditCore.aggregate` 核对总负债。
- 基金历史 `net_value` 是每日收益金额、`market_val` 是当日增持本金。期初基金和固定资产视为已经持有的资产；未虚构区间内购买支出。
- 自动资产快照按现金类资产与信用债生成；手动资产登记包含基金和固定资产，并保存组成明细。
- 工资采用工作日等额税后日薪简化模型，年间调整工资，月末入账。当前未结束月份只累计已赚工资。
- 日记每天生成，待办包含已完成、逾期和待完成，历史工作、计划和分期记录具备关联。
- 默认不生成 AI 数据，只保留 AI 表结构。原库 API 地址、模型和 Key 由独立迁移处理；校验支持迁入的有效供应商配置。

只有明确需要 AI 合成历史时才添加 `--ai-history`。该选项生成标注为演示的会话、消息、草稿和任务：供应商配置禁用，授权撤销，锁释放，后台备份未实际执行。该选项不会发起真实模型调用。

生成器补齐 `live.sql` 遗漏的 008 密码时间列。历史 005 迁移会将周期计划的 `account_id` 从当前 DDL 的 1000 缩成 50；工具仅在新 mock 库执行迁移后恢复 1000，保证分期 JSON 可以保存。DDL 提取识别 SQL 引号内的分号，避免表注释导致建表被截断。

验证：

```powershell
npm test -- --runInBand tests/unit/mockDatabase.test.js
```

覆盖连续日期、42 表结构及 AI 默认留空、显式 AI 历史选项、错误余额和缺失快照的拒绝、相同 seed 重现、SQL 注释、目标库保护及闰日边界。`verify` 从原 manifest 恢复日期、种子与 AI 历史选项，并真库回读检查金额、日期、唯一键、关联、每日累计快照、基金累计和薪资。
