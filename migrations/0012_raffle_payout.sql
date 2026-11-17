-- Raffle payouts (#1085): one row per raffle winner, written before any points are credited.
-- paid_at is set in the same transaction as the winner's loyalty_points credit, so a retry after
-- an ambiguous commit sees the row already paid and never credits that winner twice. A row left
-- with paid_at NULL is a winner who was announced as unpaid.
CREATE TABLE IF NOT EXISTS raffle_payout (
  id              BIGINT       NOT NULL AUTO_INCREMENT,
  raffle_id       CHAR(36)     NOT NULL,
  streamer_id     INT          NOT NULL,
  twitch_username VARCHAR(64)  NOT NULL,
  amount          INT          NOT NULL,
  created_at      TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  paid_at         TIMESTAMP    NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_raffle_payout_winner (raffle_id, twitch_username),
  KEY idx_raffle_payout_streamer (streamer_id, created_at),
  CONSTRAINT fk_raffle_payout_streamer
    FOREIGN KEY (streamer_id) REFERENCES streamer(id) ON DELETE CASCADE,
  CONSTRAINT chk_raffle_payout_amount CHECK (amount > 0)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- The dashboard's "Recent Events" feed shows the streamer each raffle winner whose points
-- couldn't be added.
ALTER TABLE streamer_event_log
  MODIFY COLUMN event_type ENUM('follow','sub','resub','giftsub','raid','redemption','raffle_payout_failed') NOT NULL;
