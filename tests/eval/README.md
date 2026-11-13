# AI 黄金评测集（§5 C）

回答质量的自动回归基线：换模型 / 改 prompt / 动 claims 规则前后跑同一组黄金用例，看分项判定，替代手写断言脚本人工跑。

## 两档执行

| 档 | 命令 | 供应商 | 用途 | 落档 |
| --- | --- | --- | --- | --- |
| offline | `npx jest tests/eval/aiEvalOffline.test.js`（已并入默认全回归） | 无（脚本化 provider 驱动真实 v3Service 全链路） | 断言路由、工具序列、证据门与接地安全 | 随回归报告 |
| live | `AI_EVAL_LIVE=1 npm run test:ai:eval:live` | 真实供应商（固定隔离库 live_ai_test；密文只读复制自配置源库） | 回答质量基线（要点命中 / 语言 / 接地 / fallback 率） | `api/logs/REVIEW_<上海日期>_AI_EVAL_<model>.md`（分版本，不覆盖历史） |

- live 档默认 skip（不设 `AI_EVAL_LIVE=1` 不烧 token）。工具序列仅记录；严格判定维度：期望要点 / 禁止项 / 语言 / 数字接地 / 草稿金额。`fallback=是` 仅表示实际答复与 offline scripted 措辞不同，不能据此断言模型实际答复被证据门替换。
- live 基线流程：换模型/改 prompt 先跑 offline（必须全绿），必要时跑 live 对比上一份报告（文件名含日期与模型，天然分版本）。
- `requiresSearch:true` 用例仅在站点 `AI_SEARCH_BASE_URL/API_KEY/PROVIDER` 配置完整且有效时执行。未配置则逐项记 `SKIP` 和原因，不调用模型/搜索，不计入通过率；配置经同一 `getConfig` 校验且由 `buildServer → providerEnv` 原样保留搜索槽位。
- 配置源默认 `.env` 的 `DB_NAME`，可用 `AI_EVAL_SOURCE_DB` 指定；写库始终固定 `live_ai_test`，不能将 live 档指向生产业务库。`AI_EVAL_PROFILE_USER` 可从进程环境或 `.env` 指定；未设置时只接受配置源中唯一接入商用户，多个用户必须显式选择。`AI_EVAL_MODEL` 可显式选择基线型号。默认 test setup 的测试数据库名和 JWT 不用于读取配置源。
- 每轮重建隔离库；补种 helper 在事务前验证 `SELECT DATABASE()` 和 fixture 用户，不满足 `live_ai_test/ai_real_test_user` 即拒绝任何写入。真模型异常、任何接地失败、补种域要点缺失均使 live 套件失败；报告仍在清理前落档。
- 零付费种子检查：`AI_EVAL_SEED_VERIFY=1 node tests/eval/verifyLiveFixtures.js`，仅重建 `live_ai_test`，通过真实 `businessRead` SQL 回读七个数据集的预期数字，同时验证搜索预算两执行器20并发/重启新store/次日及延迟旧日边界；不连接供应商。运行后删除隔离库的 `ai_config` 测试行。
- 付费定向验收可设 `AI_EVAL_CASES=id1,id2`；未知id会拒绝启动，报告标明定向范围，不能冒充全量基线。不设则执行全部用例。web用例的offline假客户端不调用搜索源；live未配置源逐项SKIP。

## 用例格式（cases/golden-cases.jsonl，一行一条）

2026-11-13 起，live报告及配套源码清单/逐例JSON统一写入 `temp/api-logs-archive/ai-eval/<上海日期>/`，分版本不覆盖。每例两读完成回执、同请求重放不增加 provider_calls、SQL历史正文一致均纳入严格判定。设置 `AI_EVAL_PROVIDER_HOST` 时，实际供应商主机不符则在建库/付费之前拒绝。报告源码摘要须与外部冻结清单核对；上方 api/logs 路径为此前历史位置。

```json
{"id":"fin-monthly-fuzzy","scene":"chat","message":"上个月我花了多少钱？",
 "toolScript":[["query_data",{"datasetId":"finance-monthly","startDate":"2026-10-01","endDate":"2026-10-31"}]],
 "final":{"answer":"上个月（2026-10）总支出 4250.50 元，共 57 笔。"},
 "datasets":["finance-monthly"],
 "expect":{"tools":["query_data"],"answerContains":["4250.50","57"],"language":"zh","groundedNumbers":true},
 "note":"模糊问法→月度汇总标准口径"}
```

| 字段 | 说明 |
| --- | --- |
| `id` | 唯一标识（重复会被套件拒绝） |
| `message` | 用户问句（含模糊问法 / 多步 / 边界日期 / 闲聊拒答） |
| `toolScript` | offline 档每轮脚本化 tool_calls；缺省 = 无工具轮 |
| `final` / `draft` | 终稿 JSON；draft 用例由 harness 从 list_choices 回执注入运行时 ref |
| `datasets` | harness 数据集注册表键名（数字自洽：期望要点必须能在回执中找到） |
| `expect.tools` | 期望工具序列（严格断言） |
| `expect.answerContains` / `answerNotContains` | 要点与禁止项（offline 档在 scripted 答案被证据门替换时自动放宽为接地断言） |
| `expect.language` | `zh`/`en` |
| `expect.groundedNumbers` + `allowedNumbers` | 答案金额必须出现在工具回执中；calculate 派生数字登记进 allowedNumbers |
| `expect.proposalAmount` / `noDataPrefetch` / `providerCalls` | 草稿金额 / 闲聊零取数 / 供应商轮数 |

## 新增用例流程

1. 在 `cases/golden-cases.jsonl` 追加一行（保持 JSONL 合法、id 唯一）。
2. 若需要新数据集/新数字：在 `offlineHarness.js` 的 `DATASETS` 注册表加自洽条目（字段名必须在该域 `FIELD_ALLOWLIST` 内，金额为 ≤4 位小数字符串）。
3. `npx jest tests/eval/aiEvalOffline.test.js` 必须全绿——scripted 答案若被证据门替换，先核对措辞是否触发了 claims/证据门语义（这是信号，不是噪音），确认属预期门行为后再决定改措辞或登记 fallback。
4. 需要真模型基线时跑一次 live 档，报告自动落档。

## live 档已知边界（2026-11-12 基线 v1 后记）

1. **种子覆盖面（已实现，真模型复测待执行）**：live-only `liveFixtures.js` 补种预算 2000/登记使用1450，近期待办及下月还款，工资8500/8800及时薪50，基金本金12000/5400及收益增量850/-200，分期416.67及6总期数/1待入账，保存余额按借记52000/信用负8500/微信320组成。基金按真实 reader 的收益与本金增量口径播种；资产组成来自账户余额，不是资产总额快照。未修改共享 tests/real harness。
2. **日期基准**：live 用上海真实今天，预算为当月、工资为前两月、近期待办为后两天、还款为下月首日；live 工资问句与下月日期期望由 live-only helper 同步。offline 仍用固定时钟2026-11-07。finance/card 原共享种子没有对齐 offline 总量，两档所有数字仍不能整体视为相同。
3. **grounding 检查口径（已修）**：完整规范化数字匹配，识别合法千分位、负号，排除明确日期（50不能因8500放行，450不能因1450放行）。接地来源为rows/summary、明确allowedNumbers及本轮成功calculate回执的实际value；calculate审计须与实际toolTrace digest和结果SHA-256匹配，表达式输入/cents不放行。只有匹配的真实交易草稿可使用用户原话金额。工具序列live仅记录。
4. **基线 v1证明边界**：旧报告保留31用例与28/31措辞差异记录；旧substring口径与缺种子不能证明“零数字泄漏”，措辞差异也不能证明证据门接管。本次真实补种域验收发现未调用calculate的派生数字与供应商非法工具参数，须按新报告逐项处理；两轮口径变化不能当模型能力改善。

## 已知边界

- offline 档不覆盖 memory/history 工具流（有专属单测套件）；live 档 harness 沿用 tests/real（真库 + 真 provider + 密文复制）。
- 排名类断言（最高/最大/最多）需要答案含「已定价」且行全部返回，或数据集自带 rankingComplete meta——这是证据门语义，不是措辞偏好。
- `v3Tools.js` 通用 queryMeta 构建器曾丢失 cardTypes（2026-11-12 本评测集发现并修复）：effectiveArgs 与 queryMeta.filters 不一致会让 card 类 requireFreshQuery 任务永远 missing。
- `installment-plans.periods` 是保存总期数，不能把它直接解释为“剩余期数”；当前用例的416.67要点可比较，剩余期数表达仍须以真实证据门为准。
