-- Viewer loyalty points: a per-streamer currency viewers passively earn by chatting (and get
-- bonus awards for subs/resubs/gift subs), can check/gamble via chat commands, and streamers
-- can tune the earn rates for from the web panel. Named "loyalty_points" (not "channel_points")
-- to avoid colliding with the existing Twitch Channel Points reward-pricing feature
-- (reward_pricing / channelPointsAdmin.ts), which this is unrelated to.
CREATE TABLE loyalty_points (
  id              INT          AUTO_INCREMENT PRIMARY KEY,
  streamer_id     INT          NOT NULL,
  twitch_username VARCHAR(64)  NOT NULL,
  balance         INT          NOT NULL DEFAULT 0,
  updated_at      TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_loyalty_points (streamer_id, twitch_username),
  KEY idx_loyalty_points_leaderboard (streamer_id, balance DESC),
  FOREIGN KEY (streamer_id) REFERENCES streamer(id) ON DELETE CASCADE,
  CONSTRAINT chk_loyalty_points_balance_nonnegative CHECK (balance >= 0)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Per-streamer earn-rate configuration. Absent row for a streamer falls back to the app's
-- default constants (see shared/config.ts) rather than needing a seed row per streamer.
CREATE TABLE loyalty_points_config (
  streamer_id         INT       NOT NULL PRIMARY KEY,
  points_per_message  INT       NOT NULL DEFAULT 1,
  cooldown_seconds     INT       NOT NULL DEFAULT 60,
  points_per_sub       INT       NOT NULL DEFAULT 100,
  points_per_gift_sub  INT       NOT NULL DEFAULT 100,
  updated_at           TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY (streamer_id) REFERENCES streamer(id) ON DELETE CASCADE,
  CONSTRAINT chk_loyalty_points_config_points_per_message CHECK (points_per_message >= 0),
  CONSTRAINT chk_loyalty_points_config_cooldown_seconds    CHECK (cooldown_seconds >= 0),
  CONSTRAINT chk_loyalty_points_config_points_per_sub       CHECK (points_per_sub >= 0),
  CONSTRAINT chk_loyalty_points_config_points_per_gift_sub  CHECK (points_per_gift_sub >= 0)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
