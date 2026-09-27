-- Durable per-redemption progress ledger (#690). handleRedemption checks and updates it so a
-- retry, or an EventSub reconciliation replay up to MAX_CURSOR_LAG_MS (1 hour) back, never
-- re-applies an effect (dashboard row, dynamic-pricing increment) that already ran — the
-- in-memory dedup cache only remembers a redemption for 10 minutes. handled_at is set once every
-- required effect has succeeded. Rows are pruned by age (6 hours) from the reconciliation tick.
CREATE TABLE IF NOT EXISTS redemption_handled (
  redemption_id      VARCHAR(64) NOT NULL,
  streamer_id        INT         NOT NULL,
  dashboard_recorded TINYINT(1)  NOT NULL DEFAULT 0,
  pricing_applied    TINYINT(1)  NOT NULL DEFAULT 0,
  handled_at         DATETIME    NULL,
  created_at         DATETIME    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (redemption_id),
  KEY idx_redemption_handled_created (created_at),
  FOREIGN KEY (streamer_id) REFERENCES streamer(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
