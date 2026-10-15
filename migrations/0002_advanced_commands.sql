-- Advanced commands: per-streamer commands with a loyalty-point cost, free Stream Deck triggers,
-- and video/alert overlay and companion-app effects. Every statement is CREATE TABLE IF NOT
-- EXISTS, so a part-way failure can be fixed and the file re-run.

-- ---------------------------------------------------------------------------
-- advanced_command
-- One streamer's command. Owned by a single streamer (never shared or assigned).
-- trigger_string NULL = Stream Deck only (no chat trigger).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS advanced_command (
  id                           INT          NOT NULL AUTO_INCREMENT,
  streamer_id                  INT          NOT NULL,
  name                         VARCHAR(64)  NOT NULL,
  trigger_string               VARCHAR(255) NULL,
  is_enabled                   TINYINT(1)   NOT NULL DEFAULT 1,
  response                     TEXT         NULL,
  point_cost                   INT          NOT NULL DEFAULT 0,
  price_step                   INT          NOT NULL DEFAULT 0,
  max_cost                     INT          NULL,
  global_cooldown_seconds      INT          NOT NULL DEFAULT 0,
  user_cooldown_seconds        INT          NOT NULL DEFAULT 0,
  min_role                     ENUM('everyone','subscriber','vip','moderator') NOT NULL DEFAULT 'everyone',
  live_only                    TINYINT(1)   NOT NULL DEFAULT 0,
  max_uses_per_stream          INT          NULL,
  max_uses_per_user_per_stream INT          NULL,
  companion_enabled            TINYINT(1)   NOT NULL DEFAULT 0,
  created_at                   TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at                   TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_advanced_command_name (streamer_id, name),
  UNIQUE KEY uq_advanced_command_trigger (streamer_id, trigger_string),
  KEY idx_advanced_command_trigger (trigger_string),
  FOREIGN KEY (streamer_id) REFERENCES streamer(id) ON DELETE CASCADE,
  CONSTRAINT chk_advanced_command_point_cost      CHECK (point_cost >= 0),
  CONSTRAINT chk_advanced_command_price_step      CHECK (price_step >= 0),
  CONSTRAINT chk_advanced_command_max_cost        CHECK (max_cost IS NULL OR max_cost >= point_cost),
  CONSTRAINT chk_advanced_command_global_cooldown CHECK (global_cooldown_seconds >= 0),
  CONSTRAINT chk_advanced_command_user_cooldown   CHECK (user_cooldown_seconds >= 0),
  CONSTRAINT chk_advanced_command_max_uses        CHECK (max_uses_per_stream IS NULL OR max_uses_per_stream > 0),
  CONSTRAINT chk_advanced_command_max_user_uses   CHECK (max_uses_per_user_per_stream IS NULL OR max_uses_per_user_per_stream > 0)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------------
-- advanced_command_param
-- Key/value parameters sent with the command's companion event.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS advanced_command_param (
  command_id  INT          NOT NULL,
  param_key   VARCHAR(32)  NOT NULL,
  param_value VARCHAR(255) NOT NULL,
  PRIMARY KEY (command_id, param_key),
  FOREIGN KEY (command_id) REFERENCES advanced_command(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------------
-- advanced_command_video
-- Overlay videos a command plays (weighted random, same as overlay_reward_video).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS advanced_command_video (
  command_id INT NOT NULL,
  video_id   INT NOT NULL,
  weight     INT NOT NULL DEFAULT 1,
  PRIMARY KEY (command_id, video_id),
  FOREIGN KEY (command_id) REFERENCES advanced_command(id) ON DELETE CASCADE,
  FOREIGN KEY (video_id)   REFERENCES overlay_video(id)    ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------------
-- advanced_command_alert
-- Optional alerts-overlay alert for a command (same fields as alert_config).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS advanced_command_alert (
  command_id       INT          NOT NULL,
  message_template VARCHAR(500) NOT NULL,
  image_filename   VARCHAR(255) NULL,
  sound_filename   VARCHAR(255) NULL,
  duration_ms      INT          NOT NULL DEFAULT 6000,
  text_animation   ENUM('none','wave','pulse','glitch','shake','rainbow','flicker','tilt','bounce-in','typewriter')
                                 NOT NULL DEFAULT 'none',
  PRIMARY KEY (command_id),
  FOREIGN KEY (command_id) REFERENCES advanced_command(id) ON DELETE CASCADE,
  CONSTRAINT chk_advanced_command_alert_duration CHECK (duration_ms > 0)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------------
-- advanced_command_usage
-- One row per trigger: the streamer's usage log, the per-stream cap/pricing
-- counter, and the refund ledger for companion acknowledgements.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS advanced_command_usage (
  id                BIGINT       NOT NULL AUTO_INCREMENT,
  event_id          CHAR(36)     NOT NULL,
  command_id        INT          NULL,
  streamer_id       INT          NOT NULL,
  command_name      VARCHAR(64)  NOT NULL,
  source            ENUM('chat','streamdeck') NOT NULL,
  twitch_username   VARCHAR(64)  NULL,
  points_spent      INT          NOT NULL DEFAULT 0,
  stream_started_at DATETIME     NULL,
  status            ENUM('pending','succeeded','refunded','no_ack_needed') NOT NULL,
  refund_reason     VARCHAR(64)  NULL,
  error_message     VARCHAR(255) NULL,
  triggered_at      TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  resolved_at       TIMESTAMP    NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_advanced_command_usage_event (event_id),
  KEY idx_advanced_command_usage_streamer (streamer_id, triggered_at),
  KEY idx_advanced_command_usage_stream (command_id, stream_started_at),
  KEY idx_advanced_command_usage_status (status, triggered_at),
  FOREIGN KEY (command_id)  REFERENCES advanced_command(id) ON DELETE SET NULL,
  FOREIGN KEY (streamer_id) REFERENCES streamer(id)         ON DELETE CASCADE,
  CONSTRAINT chk_advanced_command_usage_points CHECK (points_spent >= 0)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
