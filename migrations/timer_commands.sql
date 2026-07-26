-- Per-streamer, Twitch-only auto-posted chat messages (timer commands). Config-only —
-- the scheduler's live/message-count firing state is kept in memory, not persisted here.
CREATE TABLE timer_command (
  id               INT          AUTO_INCREMENT PRIMARY KEY,
  streamer_id      INT          NOT NULL,
  name             VARCHAR(255) NOT NULL,
  message          VARCHAR(500) NOT NULL,
  interval_seconds INT          NOT NULL,
  min_messages     INT          NOT NULL DEFAULT 0,
  require_live     TINYINT(1)   NOT NULL DEFAULT 1,
  enabled          TINYINT(1)   NOT NULL DEFAULT 1,
  FOREIGN KEY (streamer_id) REFERENCES streamer(id) ON DELETE CASCADE,
  CONSTRAINT chk_timer_command_interval CHECK (interval_seconds >= 60),
  CONSTRAINT chk_timer_command_min_messages CHECK (min_messages >= 0)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
