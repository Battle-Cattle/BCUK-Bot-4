-- Channel-point rewards that wait for the streamer's companion app to confirm it ran the
-- reward's actions. An unconfirmed redemption is cancelled on Twitch (refunding the viewer) and
-- its dynamic-pricing increment is taken back off. Every statement is CREATE TABLE IF NOT
-- EXISTS, so a part-way failure can be fixed and the file re-run.

-- ---------------------------------------------------------------------------
-- reward_companion_confirmation
-- One row per reward that requires companion confirmation; no row = off.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS reward_companion_confirmation (
  streamer_id      INT          NOT NULL,
  twitch_reward_id VARCHAR(255) NOT NULL,
  created_at       TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (streamer_id, twitch_reward_id),
  FOREIGN KEY (streamer_id) REFERENCES streamer(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------------
-- redemption_companion_ack
-- One row per redemption of such a reward: the ledger that makes the
-- fulfil-or-refund decision happen exactly once.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS redemption_companion_ack (
  redemption_id    VARCHAR(64)  NOT NULL,
  streamer_id      INT          NOT NULL,
  twitch_reward_id VARCHAR(255) NOT NULL,
  reward_title     VARCHAR(255) NOT NULL,
  user_login       VARCHAR(64)  NOT NULL,
  status           ENUM('pending','fulfilled','refunded','refund_failed') NOT NULL DEFAULT 'pending',
  refund_reason    VARCHAR(64)  NULL,
  error_message    VARCHAR(255) NULL,
  redeemed_at_ms   BIGINT       NOT NULL,
  created_at       TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  resolved_at      TIMESTAMP    NULL,
  PRIMARY KEY (redemption_id),
  KEY idx_redemption_companion_ack_status (status),
  KEY idx_redemption_companion_ack_resolved (resolved_at),
  FOREIGN KEY (streamer_id) REFERENCES streamer(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
