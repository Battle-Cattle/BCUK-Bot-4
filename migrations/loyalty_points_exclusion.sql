-- Per-streamer list of accounts (in practice, chat bots) excluded from loyalty points: they never
-- earn points on that streamer's channel and are hidden from the leaderboard. Managed from the
-- leaderboard's "Exclude bot" button on the /loyalty-points web page. An excluded account's
-- loyalty_points row is kept as-is, so removing the exclusion restores its previous balance.
CREATE TABLE IF NOT EXISTS loyalty_points_exclusion (
  streamer_id     INT         NOT NULL,
  twitch_username VARCHAR(64) NOT NULL,
  created_at      TIMESTAMP   NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (streamer_id, twitch_username),
  FOREIGN KEY (streamer_id) REFERENCES streamer(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
