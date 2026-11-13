-- 2026-11-13: 站点默认值与用户可调整额度。保留已有非空配置、思考和联网偏好。
CREATE TABLE IF NOT EXISTS ai_config (
  id TINYINT UNSIGNED NOT NULL DEFAULT 1,
  daily_provider_calls INT UNSIGNED DEFAULT 10000,
  max_usage_tokens INT UNSIGNED DEFAULT 1000000,
  max_output_tokens VARCHAR(12) DEFAULT 'max',
  provider_timeout_ms INT UNSIGNED DEFAULT 105000,
  turn_timeout_ms INT UNSIGNED DEFAULT 300000,
  history_tokens INT UNSIGNED DEFAULT NULL,
  search_daily_calls INT UNSIGNED DEFAULT NULL,
  search_usage_day CHAR(10) DEFAULT NULL,
  search_calls_used INT UNSIGNED NOT NULL DEFAULT 0,
  updated_at BIGINT NOT NULL,
  PRIMARY KEY (id),
  CONSTRAINT chk_ai_config_single CHECK (id = 1)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci ROW_FORMAT=DYNAMIC COMMENT='AI 站点默认配置';

ALTER TABLE ai_config MODIFY daily_provider_calls INT UNSIGNED DEFAULT 10000;
ALTER TABLE ai_config MODIFY max_usage_tokens INT UNSIGNED DEFAULT 1000000;
ALTER TABLE ai_config MODIFY max_output_tokens VARCHAR(12) DEFAULT 'max';
ALTER TABLE ai_config MODIFY provider_timeout_ms INT UNSIGNED DEFAULT 105000;
ALTER TABLE ai_config MODIFY turn_timeout_ms INT UNSIGNED DEFAULT 300000;

INSERT IGNORE INTO ai_config (id, updated_at) VALUES (1, CAST(UNIX_TIMESTAMP(CURRENT_TIMESTAMP(3)) * 1000 AS UNSIGNED));
UPDATE ai_config SET daily_provider_calls = COALESCE(daily_provider_calls, 10000),
  max_usage_tokens = COALESCE(max_usage_tokens, 1000000), max_output_tokens = COALESCE(max_output_tokens, 'max'),
  provider_timeout_ms = COALESCE(provider_timeout_ms, 105000), turn_timeout_ms = COALESCE(turn_timeout_ms, 300000),
  updated_at = CAST(UNIX_TIMESTAMP(CURRENT_TIMESTAMP(3)) * 1000 AS UNSIGNED) WHERE id = 1;

ALTER TABLE ai_user_preference ADD COLUMN web_search_enabled TINYINT(1) NOT NULL DEFAULT 0;
ALTER TABLE ai_user_preference ADD COLUMN daily_provider_calls INT UNSIGNED DEFAULT NULL;
ALTER TABLE ai_user_preference ADD COLUMN max_usage_tokens INT UNSIGNED DEFAULT NULL;
ALTER TABLE ai_user_preference ADD COLUMN max_output_tokens VARCHAR(12) DEFAULT NULL;
ALTER TABLE ai_user_preference ADD COLUMN provider_timeout_ms INT UNSIGNED DEFAULT NULL;
ALTER TABLE ai_user_preference ADD COLUMN turn_timeout_ms INT UNSIGNED DEFAULT NULL;
