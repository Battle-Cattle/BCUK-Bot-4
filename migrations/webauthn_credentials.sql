-- Passkeys (WebAuthn credentials) for fingerprint / Face ID / Windows Hello sign-in to the
-- web panel. A user enrols a passkey from User Settings after signing in with Discord;
-- the passkey then signs them in without the Discord OAuth round-trip.
-- Run after the base schema is in place.

CREATE TABLE webauthn_credentials (
  -- base64url credential ID; ascii_bin because IDs are case-sensitive.
  credential_id VARCHAR(512) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  discord_id    BIGINT        NOT NULL,
  public_key    VARBINARY(1024) NOT NULL,
  sign_count    INT UNSIGNED  NOT NULL DEFAULT 0,
  transports    VARCHAR(255)  NULL,
  device_label  VARCHAR(100)  NOT NULL,
  created_at    DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_used_at  DATETIME      NULL,
  PRIMARY KEY (credential_id),
  KEY idx_webauthn_credentials_discord_id (discord_id),
  FOREIGN KEY (discord_id) REFERENCES `user`(discord_id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
