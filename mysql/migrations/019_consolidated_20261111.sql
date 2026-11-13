-- 019: 2026-11-06 ~ 11-11 七项 AI 增量合并（2026-11-11 整理）
--
-- 来源（原七个文件已删除）：
--   019_ai_business_workspace.sql      （2026-11-06）
--   020_ai_transaction_candidates.sql  （2026-11-06）
--   021_ai_call_log_preference.sql     （2026-11-07）
--   022_ai_grant_provider_settings.sql （2026-11-07）
--   023_ai_provider_profiles.sql       （2026-11-08）
--   024_ai_chat_activity.sql           （2026-11-10）
--   025_ai_call_log_phase_width.sql    （2026-11-11）
--
-- 为什么合并：migrationRunner 只按文件名 .sort() 执行；合并为一个 019 前缀文件后
--   编号恢复连续，后续新增从 020_ 开始即可。
--
-- 幂等性（重复执行安全）：
--   1) CREATE TABLE IF NOT EXISTS：表已存在则保留结构与数据；
--   2) ALTER TABLE ai_conversation 重复列/索引由 migrationRunner 按
--      ER_DUP_FIELDNAME / ER_DUP_KEYNAME 跳过；ai_call_log.phase 为 MODIFY，可重复执行；
--   3) 023 的旧接入商搬迁为 INSERT IGNORE + LEFT JOIN 判空，仅补无接入商的账号。
--
-- ⚠ 文件名是**新的**（不是原 019）：已执行过旧 019~025 的库也会重跑本文件一次，
--   这是有意的 —— 确保每条变更一定被补上；所有语句均幂等，无副作用。
--   旧记录（019_ai_business... ~ 025_ai_call_log...）留在 _migrations 表里无害。
--   仅增 AI 结构；不插入样例、不清理账务、不重算金融数据、不保存图片字节。

-- ===== 019: AI 业务工作区和单次请求保护（2026-11-06）=====

CREATE TABLE IF NOT EXISTS `ai_analysis_preview` (
  `id` VARCHAR(50) NOT NULL,
  `user_id` VARCHAR(64) NOT NULL,
  `digest` CHAR(64) NOT NULL,
  `payload` MEDIUMTEXT NOT NULL COMMENT '加密JSON：授权快照、随机引用map、原话和供应商指纹',
  `created_at` BIGINT NOT NULL,
  `expires_at` BIGINT NOT NULL,
  `approved_at` BIGINT NULL,
  `request_id` CHAR(36) NULL COMMENT '一次消费，禁止换请求编号重发同一预览',
  PRIMARY KEY (`id`),
  KEY `idx_user_expires` (`user_id`,`expires_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci ROW_FORMAT=DYNAMIC COMMENT='AI范围授权预览，不保存图片';

CREATE TABLE IF NOT EXISTS `ai_business_proposal` (
  `id` VARCHAR(50) NOT NULL,
  `user_id` VARCHAR(64) NOT NULL,
  `kind` VARCHAR(40) NOT NULL,
  `payload` JSON NOT NULL,
  `source` VARCHAR(20) NOT NULL,
  `conversation_id` VARCHAR(50) NULL,
  `preview_id` VARCHAR(50) NULL,
  `status` ENUM('pending','reviewed','committed','discarded') NOT NULL DEFAULT 'pending',
  `version` INT NOT NULL DEFAULT 1,
  `expires_at` BIGINT NOT NULL,
  `receipt` JSON NULL,
  `target_snapshot` JSON NULL,
  `created_at` VARCHAR(20) NOT NULL,
  `updated_at` VARCHAR(20) NOT NULL,
  PRIMARY KEY (`id`),
  KEY `idx_user_status` (`user_id`,`status`),
  KEY `idx_preview` (`preview_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci ROW_FORMAT=DYNAMIC COMMENT='独立AI业务提案，正式执行只收ID和版本';

CREATE TABLE IF NOT EXISTS `ai_background_job` (
  `id` VARCHAR(50) NOT NULL,
  `user_id` VARCHAR(64) NOT NULL,
  `proposal_id` VARCHAR(50) NOT NULL,
  `status` ENUM('queued','running','succeeded','failed') NOT NULL DEFAULT 'queued',
  `worker_id` VARCHAR(64) NULL,
  `receipt` JSON NULL,
  `error_message` VARCHAR(255) NULL,
  `created_at` VARCHAR(20) NOT NULL,
  `updated_at` VARCHAR(20) NOT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_proposal` (`proposal_id`),
  KEY `idx_user` (`user_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci ROW_FORMAT=DYNAMIC COMMENT='人工确认后固定系统备份任务，不自动重试';

CREATE TABLE IF NOT EXISTS `ai_request_run` (
  `id` CHAR(36) NOT NULL,
  `user_id` VARCHAR(64) NOT NULL,
  `lane` VARCHAR(32) NOT NULL,
  `input_digest` CHAR(64) NOT NULL,
  `status` ENUM('running','completed','failed') NOT NULL,
  `provider_calls` INT NOT NULL DEFAULT 0,
  `max_provider_calls` INT NOT NULL DEFAULT 1,
  `created_at` BIGINT NOT NULL,
  `deadline_at` BIGINT NOT NULL,
  `expires_at` BIGINT NOT NULL,
  `result_payload` MEDIUMTEXT NULL COMMENT '加密结果，超时只读回执不重发',
  `error_code` VARCHAR(64) NULL,
  PRIMARY KEY (`user_id`,`id`),
  KEY `idx_expires` (`expires_at`),
  KEY `idx_user_created` (`user_id`,`created_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci ROW_FORMAT=DYNAMIC COMMENT='AI持久去重和每轮供应商调用硬预算';

CREATE TABLE IF NOT EXISTS `ai_request_lane` (
  `user_id` VARCHAR(64) NOT NULL,
  `active_request_id` VARCHAR(64) NULL,
  `locked_until` BIGINT NOT NULL DEFAULT 0,
  `request_count` INT UNSIGNED NOT NULL DEFAULT 0,
  `window_start` BIGINT NOT NULL DEFAULT 0,
  `updated_at` VARCHAR(20) NULL,
  PRIMARY KEY (`user_id`),
  KEY `idx_locked_until` (`locked_until`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci ROW_FORMAT=DYNAMIC COMMENT='跨进程用户并发锁和分钟限流';

ALTER TABLE `ai_conversation` ADD COLUMN `session_kind` ENUM('legacy','default','manual') NOT NULL DEFAULT 'legacy';
ALTER TABLE `ai_conversation` ADD COLUMN `session_day` DATE NULL;
ALTER TABLE `ai_conversation` ADD UNIQUE KEY `uk_user_default_day` (`user_id`,`session_kind`,`session_day`);

-- ===== 020: 交易候选和财务预检（2026-11-06）=====
-- 候选原话/OCR短证据加密；图片字节不存储。请求编号永久防重建。

CREATE TABLE IF NOT EXISTS `ai_transaction_candidate` (
  `id` VARCHAR(50) NOT NULL,
  `user_id` VARCHAR(64) NOT NULL,
  `source` VARCHAR(20) NOT NULL,
  `conversation_id` VARCHAR(50) NULL,
  `request_id` CHAR(36) NULL,
  `source_fingerprint` CHAR(64) NULL COMMENT '本人范围内相同来源去重，不保存图片',
  `input_digest` CHAR(64) NOT NULL,
  `payload` MEDIUMTEXT NOT NULL COMMENT '加密JSON：候选字段、原话/识别短证据和来源',
  `status` ENUM('pending','consumed','discarded','failed') NOT NULL DEFAULT 'pending',
  `draft_id` CHAR(36) NULL,
  `created_at` BIGINT NOT NULL,
  `expires_at` BIGINT NOT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_candidate_request` (`user_id`,`request_id`),
  UNIQUE KEY `uk_candidate_source` (`user_id`,`source_fingerprint`),
  KEY `idx_candidate_expiry` (`user_id`,`expires_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci ROW_FORMAT=DYNAMIC COMMENT='交易补充候选，不是可执行草稿；无图像';

-- ===== 021: AI 全链路审计日志 + 用户偏好（2026-11-07）=====
-- 保留期默认 90 天（AI_LOG_RETENTION_DAYS 可调）；API Key/凭据永不入任何字段。

CREATE TABLE IF NOT EXISTS `ai_call_log` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `user_id` VARCHAR(64) NOT NULL,
  `request_id` CHAR(36) NULL COMMENT '本轮守卫 requestId（meta 调用可为空）',
  `conversation_id` VARCHAR(50) NULL,
  `lane` VARCHAR(32) NOT NULL COMMENT 'legacy-chat/business-chat/ocr/local-draft/models/balance/settings',
  `phase` VARCHAR(32) NOT NULL COMMENT 'provider/tool/gate/preview/meta/commit/evidence-recovery',
  `provider_host` VARCHAR(200) NULL,
  `model` VARCHAR(120) NULL,
  `thinking_enabled` TINYINT(1) NOT NULL DEFAULT 0,
  `tool_name` VARCHAR(64) NULL,
  `request_payload` MEDIUMTEXT NULL COMMENT 'JSON：messages/工具参数/门控入参（应用层截断64KB）',
  `response_payload` MEDIUMTEXT NULL COMMENT 'JSON：content/reasoning_content/tool_calls/结果（应用层截断64KB）',
  `usage` JSON NULL COMMENT 'prompt_tokens/completion_tokens/total_tokens',
  `duration_ms` INT NULL,
  `status` ENUM('ok','error') NOT NULL,
  `error_code` VARCHAR(64) NULL,
  `http_status` SMALLINT NULL,
  `origin` VARCHAR(16) NULL COMMENT 'model/user/system（工具发起方）',
  `created_at` BIGINT NOT NULL,
  PRIMARY KEY (`id`),
  KEY `idx_user_created` (`user_id`,`created_at`),
  KEY `idx_request` (`request_id`),
  KEY `idx_conversation` (`conversation_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci ROW_FORMAT=DYNAMIC COMMENT='AI 全链路审计日志：思考/调用/工具/门控 100% 追溯，保留期90天';

CREATE TABLE IF NOT EXISTS `ai_user_preference` (
  `user_id` VARCHAR(64) NOT NULL,
  `thinking_enabled` TINYINT(1) NOT NULL DEFAULT 0 COMMENT '思考能力开关（会话偏好优先于 env AI_THINKING）',
  `update_time` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`user_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci ROW_FORMAT=DYNAMIC COMMENT='AI 用户偏好（与 Key 配置解耦，env 级供应商同样生效）';

-- ===== 022: 账号 AI 授权 + 加密接入商设置（2026-11-07）=====

CREATE TABLE IF NOT EXISTS `ai_data_grant` (
  `id` INT UNSIGNED NOT NULL AUTO_INCREMENT,
  `user_id` VARCHAR(64) NOT NULL,
  `provider_host` VARCHAR(120) NOT NULL DEFAULT '' COMMENT '授权绑定的供应商主机，换连接需重新授权',
  `domains` TEXT NOT NULL COMMENT 'JSON 数组：允许 AI 读取的业务域白名单',
  `granted_at` BIGINT NOT NULL,
  `revoked_at` BIGINT NULL COMMENT '非空=已撤回（保留行作审计证物）',
  `update_time` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_grant_user` (`user_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci ROW_FORMAT=DYNAMIC COMMENT='AI 数据授权白名单；预览快照 digest 才是逐消息授权证物';

CREATE TABLE IF NOT EXISTS `ai_provider_setting` (
  `id` INT UNSIGNED NOT NULL AUTO_INCREMENT,
  `user_id` VARCHAR(64) NOT NULL,
  `provider_host` VARCHAR(200) NOT NULL COMMENT '规范化 API 地址（OpenAI 兼容 base）',
  `model` VARCHAR(120) NOT NULL,
  `api_key_cipher` TEXT NOT NULL COMMENT 'enc.v1 AES-256-GCM 加密的 API Key，密钥不出服务端',
  `key_fingerprint` CHAR(16) NOT NULL COMMENT 'Key 的 sha256 前16位，供多端一致性核对，不泄露 Key',
  `connection_id` CHAR(36) NOT NULL,
  `created_at` BIGINT NOT NULL,
  `updated_at` BIGINT NOT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_psetting_user` (`user_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci ROW_FORMAT=DYNAMIC COMMENT='AI 连接设置持久化；密文落库，GET 永不回传';

-- ===== 023: 多接入商配置（2026-11-08）=====
-- Key 继续以 enc.v1 AES-256-GCM 密文落库，is_active 标记当前生效的一家；
-- connection_id 在该接入商改地址/Key/模型时轮换，供会话失配拦截。

CREATE TABLE IF NOT EXISTS `ai_provider_profile` (
  `id` INT UNSIGNED NOT NULL AUTO_INCREMENT,
  `user_id` VARCHAR(64) NOT NULL,
  `connection_id` CHAR(36) NOT NULL COMMENT '接入商连接ID；改地址/Key/模型时轮换',
  `name` VARCHAR(60) NOT NULL COMMENT '用户可读名称',
  `provider_host` VARCHAR(200) NOT NULL COMMENT '规范化 API 地址（OpenAI 兼容 base）',
  `model` VARCHAR(120) NOT NULL,
  `api_key_cipher` TEXT NOT NULL COMMENT 'enc.v1 加密的 API Key，GET 永不回传',
  `key_fingerprint` CHAR(16) NOT NULL COMMENT 'Key 的 sha256 前16位，供多端核对',
  `is_active` TINYINT(1) NOT NULL DEFAULT 0,
  `created_at` BIGINT NOT NULL,
  `updated_at` BIGINT NOT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_profile_conn` (`user_id`, `connection_id`),
  UNIQUE KEY `uk_profile_name` (`user_id`, `name`),
  KEY `idx_profile_user_active` (`user_id`, `is_active`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci ROW_FORMAT=DYNAMIC COMMENT='AI 接入商多配置；Key 加密落库，GET 永不回传';

-- 旧表每个账号只有一条，仅在该账号尚无接入商、且从未执行过旧 023 或本合并脚本时搬成默认接入商。
-- LEFT JOIN 判空 + INSERT IGNORE 保证重复执行不重复插入；_migrations 判据保证已升级库
-- 不会把用户后来主动删除的接入商和旧 Key 复活，也避免手工重跑合并脚本时再次搬迁。
INSERT IGNORE INTO `ai_provider_profile`
  (`user_id`, `connection_id`, `name`, `provider_host`, `model`, `api_key_cipher`, `key_fingerprint`, `is_active`, `created_at`, `updated_at`)
SELECT s.`user_id`, s.`connection_id`,
  LEFT(SUBSTRING_INDEX(SUBSTRING_INDEX(s.`provider_host`, '://', -1), '/', 1), 60),
  s.`provider_host`, s.`model`, s.`api_key_cipher`, s.`key_fingerprint`, 1, s.`created_at`, s.`updated_at`
FROM `ai_provider_setting` s
LEFT JOIN `ai_provider_profile` p ON p.`user_id` = s.`user_id`
WHERE p.`user_id` IS NULL
  AND NOT EXISTS (SELECT 1 FROM `_migrations` WHERE `filename` IN
    ('023_ai_provider_profiles.sql', '019_consolidated_20261111.sql'));

-- ===== 024: 跨设备聊天活动（2026-11-10）=====
-- 只同步状态，不授权模型或业务执行；保存加密原话，不保存图片字节。

CREATE TABLE IF NOT EXISTS `ai_chat_activity` (
  `user_id` VARCHAR(64) NOT NULL,
  `request_id` CHAR(36) NOT NULL,
  `conversation_id` VARCHAR(50) NOT NULL,
  `execution_token` CHAR(36) NOT NULL,
  `message_payload` MEDIUMTEXT NOT NULL COMMENT 'Encrypted original utterance; no image bytes',
  `status` VARCHAR(16) NOT NULL,
  `stage` VARCHAR(32) NOT NULL,
  `error_code` VARCHAR(64) NULL,
  `notice` VARCHAR(1000) NULL,
  `created_at` BIGINT NOT NULL,
  `updated_at` BIGINT NOT NULL,
  `deadline_at` BIGINT NOT NULL,
  PRIMARY KEY (`user_id`,`request_id`),
  KEY `idx_chat_activity` (`user_id`,`conversation_id`,`created_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci ROW_FORMAT=DYNAMIC COMMENT='Cross-device queued/running chat state; never authorizes execution';

-- ===== 025: 审计 phase 放宽到 32 字符（2026-11-11）=====
-- 旧库 021 初版为 VARCHAR(16)，V3 的 query-evidence-recovery(23) 与
-- language-recovery(17) 在严格模式下报 1406 并被写入层吞掉，审计链出现缺口。
-- 仅扩宽列，不改数据；MODIFY 可重复执行。
ALTER TABLE `ai_call_log` MODIFY COLUMN `phase` VARCHAR(32) NOT NULL
  COMMENT 'provider/tool/gate/preview/meta/commit/evidence-recovery';
