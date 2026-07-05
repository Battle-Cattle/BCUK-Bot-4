-- Replaces the single bot-wide pricing_global_settings row with per-streamer settings:
-- half-life is now a fixed duration (seconds), not normalized by any reward's cooldown, and
-- the redemption increment is no longer stored — it's derived per-reward from the reward's own
-- cooldown, the streamer's half-life, and time_to_max_multiplier (see rewardPricingMath.ts).
DROP TABLE IF EXISTS pricing_global_settings;

CREATE TABLE reward_pricing_settings (
  streamer_id          INT          NOT NULL,
  half_life_seconds     INT          NOT NULL DEFAULT 1800,
  time_to_max_multiplier DECIMAL(6,3) NOT NULL DEFAULT 2.000,
  PRIMARY KEY (streamer_id),
  FOREIGN KEY (streamer_id) REFERENCES streamer(id) ON DELETE CASCADE,
  CONSTRAINT chk_reward_pricing_settings_half_life CHECK (half_life_seconds > 0),
  CONSTRAINT chk_reward_pricing_settings_multiplier CHECK (time_to_max_multiplier > 0)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
