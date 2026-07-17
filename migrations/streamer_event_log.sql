-- Live activity log for the dashboard's "Recent Events" feed: follows, subs, raids, and
-- channel-point redemptions on a connected Twitch channel. Bounded to roughly the largest
-- range the dashboard displays (the latest ~20 events) — recordStreamerEvent() prunes each
-- streamer down to their most recent 200 rows on every insert, so this never grows unbounded
-- regardless of how bursty redemptions get.
CREATE TABLE streamer_event_log (
  id           INT      AUTO_INCREMENT PRIMARY KEY,
  streamer_id  INT      NOT NULL,
  event_type   ENUM('follow','sub','resub','giftsub','raid','redemption') NOT NULL,
  display_name VARCHAR(255) NOT NULL,
  detail       VARCHAR(500) NULL,
  occurred_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_streamer_event_log_recent (streamer_id, occurred_at),
  FOREIGN KEY (streamer_id) REFERENCES streamer(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
