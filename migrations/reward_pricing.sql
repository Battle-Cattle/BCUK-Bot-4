-- Dynamic Channel Point Pricing: per-reward config/demand + bot-wide decay/increment settings.
-- Independent of overlay_reward — a reward can have dynamic pricing without overlay videos and vice versa.
CREATE TABLE reward_pricing (
  id                INT          AUTO_INCREMENT PRIMARY KEY,
  streamer_id       INT          NOT NULL,
  twitch_reward_id  VARCHAR(255) NOT NULL,
  enabled           TINYINT(1)   NOT NULL DEFAULT 0,
  base_cost         INT          NOT NULL,
  cooldown_seconds  INT          NOT NULL DEFAULT 60,
  max_multiplier    DECIMAL(6,3) NOT NULL DEFAULT 1.000,
  curve             DECIMAL(5,3) NOT NULL DEFAULT 1.000,
  demand            DECIMAL(9,6) NOT NULL DEFAULT 0.000000,
  demand_updated_at BIGINT       NOT NULL,
  last_pushed_cost  INT          NULL,
  UNIQUE KEY uq_reward_pricing (streamer_id, twitch_reward_id),
  KEY idx_reward_pricing_enabled (enabled),
  FOREIGN KEY (streamer_id) REFERENCES streamer(id) ON DELETE CASCADE,
  CONSTRAINT chk_reward_pricing_base_cost        CHECK (base_cost > 0),
  CONSTRAINT chk_reward_pricing_cooldown_seconds CHECK (cooldown_seconds > 0),
  CONSTRAINT chk_reward_pricing_max_multiplier   CHECK (max_multiplier >= 0),
  CONSTRAINT chk_reward_pricing_curve            CHECK (curve > 0)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Single global row (id pinned to 1) — bot-wide decay/increment settings shared by every reward.
CREATE TABLE pricing_global_settings (
  id                       TINYINT      NOT NULL DEFAULT 1,
  decay_half_life_periods DECIMAL(8,3) NOT NULL DEFAULT 3.000,
  redemption_increment     DECIMAL(6,4) NOT NULL DEFAULT 0.1000,
  PRIMARY KEY (id),
  CONSTRAINT chk_pricing_global_settings_singleton CHECK (id = 1)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
