-- 018: AI 草稿、会话与消息持久化（2026-11-06）
-- 与 live.sql 中的三个 AI 表定义一致，补齐已有环境的增量升级路径。
-- CREATE TABLE IF NOT EXISTS：已创建的表及其数据保持不变，支持中断后重跑。
-- 仅创建 AI 表，不初始化样例、不写正式流水/余额/账单，不手工登记 _migrations。
-- JSON 列要求 MySQL 5.7.8+；沿用已联调的 UUID、日期、状态与溯源字段类型。

CREATE TABLE IF NOT EXISTS `bus_ai_draft` (
  `id` CHAR(36) NOT NULL COMMENT '草稿UUID(事务ID)',
  `user_id` VARCHAR(64) NOT NULL COMMENT '所属用户',
  `direction` TINYINT NOT NULL COMMENT '0支出 1收入',
  `amount` VARCHAR(64) NOT NULL COMMENT '金额字符串(工具层正则形态,提交时转Number复验)',
  `currency` CHAR(3) NOT NULL DEFAULT 'CNY',
  `trans_date` DATE NOT NULL,
  `category_id` VARCHAR(64) NULL,
  `account_id` VARCHAR(64) NULL COMMENT '提交时映射为cardId',
  `pay_method` VARCHAR(16) NULL,
  `remark` VARCHAR(255) NOT NULL DEFAULT '',
  `status` ENUM('pending','reviewed','committed','discarded') NOT NULL DEFAULT 'pending',
  `version` INT NOT NULL DEFAULT 1,
  `missing_fields` JSON NULL COMMENT '缺失项提示',
  `trace_snapshot` JSON NULL COMMENT '产生草稿的工具调用轨迹(溯源证物3)',
  `source` VARCHAR(16) NOT NULL DEFAULT 'user-readonly' COMMENT 'synthetic|user-readonly|image-ocr',
  `original_text` VARCHAR(1500) NOT NULL DEFAULT '' COMMENT '产生草稿的用户原话(溯源)',
  `conversation_id` CHAR(36) NULL COMMENT '产生草稿的会话(溯源)',
  `committed_record_id` VARCHAR(64) NULL COMMENT '入账后的account主键(溯源证物4)',
  `expires_at` BIGINT NOT NULL COMMENT '过期毫秒时间戳,惰性判定',
  `committed_at` DATETIME NULL,
  `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_user_status` (`user_id`,`status`),
  KEY `idx_record` (`committed_record_id`),
  KEY `idx_expires` (`expires_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 ROW_FORMAT=DYNAMIC COMMENT='AI记账草稿(事务提案,不关联余额不入统计,提交后经account模块正式入账)';

CREATE TABLE IF NOT EXISTS `ai_conversation` (
  `id` CHAR(36) NOT NULL COMMENT '会话UUID',
  `user_id` VARCHAR(64) NOT NULL,
  `latest_draft_id` VARCHAR(64) NULL COMMENT '最近草稿ID(上下文追问用)',
  `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_user_updated` (`user_id`,`updated_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 ROW_FORMAT=DYNAMIC COMMENT='AI会话元数据(历史记录)';

CREATE TABLE IF NOT EXISTS `ai_message` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `conversation_id` CHAR(36) NOT NULL,
  `user_id` VARCHAR(64) NOT NULL,
  `role` ENUM('user','assistant') NOT NULL,
  `content` TEXT NOT NULL COMMENT '展示与上下文共用内容(截断后)',
  `draft_id` VARCHAR(64) NULL COMMENT '关联草稿',
  `meta` JSON NULL COMMENT 'assistant消息附带的查询证据摘要(上下文重建用)',
  `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_conv` (`conversation_id`,`id`),
  KEY `idx_user` (`user_id`,`created_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 ROW_FORMAT=DYNAMIC COMMENT='AI聊天消息(历史持久化)';
