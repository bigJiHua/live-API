-- 017: 2026-10-08 ~ 10-13 三项增量合并（2026-10-18 整理）
--
-- 来源（原三个文件已删除）：
--   017_device_crypto_aes_key_widen.sql
--   018_work_fund_unique_keys.sql            （2026-10-13，api.md P2-10）
--   20261013_add_sys_attachment_file_hash.sql（2026-10-13，api.md P2-9）
--
-- 为什么合并：原 018 与 20261013 未沿用 001~017 的编号（后者用了日期前缀），
--   而 migrationRunner 只按文件名 .sort() 执行。以后再出现 019_ 会排到
--   20261013_ 之前，顺序不可控。合并成一个 017 前缀文件后编号恢复连续。
--
-- 幂等性（重复执行安全）：
--   1) MODIFY COLUMN 可重复执行；
--   2) 清重 DELETE 无重复时影响 0 行；ADD UNIQUE KEY 已存在时由
--      migrationRunner 按 ER_DUP_KEYNAME 跳过；
--   3) ADD COLUMN / ADD KEY 已存在时分别按 ER_DUP_FIELDNAME / ER_DUP_KEYNAME 跳过。
--
-- ⚠ 文件名是**新的**（不是原 017 同名）：已执行过旧 017 的库也会重跑本文件一次，
--   这是有意的 —— 确保原 018 / 20261013 的变更一定被补上；三条语句均幂等，无副作用。
--   旧记录（017_device_crypto... / 018_work_fund... / 20261013_...）留在 _migrations
--   表里无害，不需要手工清理。

-- ===== 1/3 device_crypto.aes_key 列宽扩展（P1-9）=====
-- 握手行 aes_key 用 AES-256-GCM 加密后约 133 字符，原 varchar(64) 装不下
-- ⇒ 握手 INSERT 报 ER_DATA_TOO_LONG(1406) ⇒ 握手 500 ⇒ 后续登录 401。
-- 存量明文值不受影响（读取侧 fieldCrypto.decryptField 兼容明文）。
ALTER TABLE `device_crypto`
  MODIFY COLUMN `aes_key` varchar(191) COLLATE utf8mb4_bin DEFAULT NULL COMMENT '临时AES密钥（P1-9起为enc.v1:密文，邮件行为userId明文）';

-- ===== 2/3 work_salary / bus_fund_history 唯一键（P2-10）=====
-- 目的：杜绝「先查后插」并发窗口产生的重复记录（工资双计 / 净值历史双计）。
-- 多部署零人工：先按 MAX(id) 自动清重（两表 id 均为 billId，MAX = 最新），再加唯一键。
-- ⚠ work_job 的「1 用户 = 1 正式工」**不加** DB 唯一键：其删除是软删（is_deleted=1 占位），
--   唯一键会被「删旧建新」误拦，维持应用层查重（已带 is_deleted=0 条件）。

-- 步骤 1/4：work_salary 清重（保留每组最新一条）
DELETE s FROM work_salary s
INNER JOIN (
  SELECT job_id, work_date, MAX(id) AS keep_id
  FROM work_salary
  GROUP BY job_id, work_date
  HAVING COUNT(*) > 1
) d ON s.job_id = d.job_id AND s.work_date = d.work_date AND s.id <> d.keep_id;

-- 步骤 2/4：work_salary 唯一键
ALTER TABLE work_salary ADD UNIQUE KEY uk_salary_job_date (job_id, work_date);

-- 步骤 3/4：bus_fund_history 清重（保留每组最新一条）
DELETE h FROM bus_fund_history h
INNER JOIN (
  SELECT fund_id, record_date, MAX(id) AS keep_id
  FROM bus_fund_history
  GROUP BY fund_id, record_date
  HAVING COUNT(*) > 1
) d ON h.fund_id = d.fund_id AND h.record_date = d.record_date AND h.id <> d.keep_id;

-- 步骤 4/4：bus_fund_history 唯一键
ALTER TABLE bus_fund_history ADD UNIQUE KEY uk_fund_record_date (fund_id, record_date);

-- ===== 3/3 sys_attachment.file_hash（P2-9 上传去重 / 秒传）=====
-- 内容 SHA-256，用于「同一用户上传相同内容直接复用、不落新盘」。
-- 代码侧 SysAttachment.findByHash 对列不存在做了降级（不阻断上传），
-- 但升到本迁移后才会真正启用去重。
ALTER TABLE `sys_attachment`
  ADD COLUMN `file_hash` varchar(64) DEFAULT NULL COMMENT '文件内容SHA-256(去重秒传)' AFTER `file_ext`,
  ADD KEY `idx_file_hash` (`user_id`, `file_hash`);
