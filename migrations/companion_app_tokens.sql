-- Companion app: self-service bearer tokens (one per user, no approval queue —
-- read-only delivery of the user's own Twitch redemption events) plus short-lived
-- single-use codes for the loopback OAuth login exchange.
-- Run after the base schema is in place.

CREATE TABLE companion_app_tokens (
  discord_id   BIGINT       NOT NULL,
  key_hash     VARCHAR(64)  NOT NULL,
  created_at   DATETIME     NOT NULL,
  revoked_at   DATETIME     NULL,
  PRIMARY KEY (discord_id),
  UNIQUE KEY uq_companion_app_tokens_key_hash (key_hash),
  FOREIGN KEY (discord_id) REFERENCES `user`(discord_id) ON DELETE CASCADE
);

CREATE TABLE companion_oauth_codes (
  code_hash    VARCHAR(64) NOT NULL,
  discord_id   BIGINT      NOT NULL,
  expires_at   DATETIME    NOT NULL,
  used_at      DATETIME    NULL,
  PRIMARY KEY (code_hash),
  FOREIGN KEY (discord_id) REFERENCES `user`(discord_id) ON DELETE CASCADE
);
