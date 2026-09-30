-- Passkeys (WebAuthn credentials) for fingerprint / Face ID / Windows Hello sign-in to the
-- web panel. A user enrols a passkey from User Settings after signing in with Discord;
-- the passkey then signs them in without the Discord OAuth round-trip.
-- Run after the base schema is in place.

CREATE TABLE webauthn_credentials (
  -- base64url credential ID; ascii_bin because IDs are case-sensitive.
  credential_id VARCHAR(512) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  discord_id    BIGINT        NOT NULL,
  -- base64url WebAuthn user handle: random per user, shared by all their passkeys. Stored
  -- rather than derived from an app secret so secret rotation never invalidates passkeys.
  user_handle   VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
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

-- Outstanding WebAuthn challenges. The session also holds the challenge (binding it to the
-- browser that asked for it), but consumption is a conditional DELETE on this table so a
-- challenge can be redeemed exactly once even by concurrent requests sharing a session.
CREATE TABLE webauthn_challenges (
  -- base64url challenge; ascii_bin because it's case-sensitive.
  challenge   VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  purpose     ENUM('register', 'login') NOT NULL,
  expires_at  DATETIME     NOT NULL,
  PRIMARY KEY (challenge),
  KEY idx_webauthn_challenges_expires_at (expires_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- One-time codes the bot DMs to a user to confirm they're the one adding a passkey (so a
-- hijacked web session alone can't enrol one). One outstanding code per user; only a SHA-256
-- digest of the code is stored.
CREATE TABLE passkey_enrollment_codes (
  discord_id  BIGINT           NOT NULL,
  code_hash   CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  attempts    TINYINT UNSIGNED NOT NULL DEFAULT 0,
  sent_at     DATETIME         NOT NULL,
  expires_at  DATETIME         NOT NULL,
  PRIMARY KEY (discord_id),
  KEY idx_passkey_enrollment_codes_expires_at (expires_at),
  FOREIGN KEY (discord_id) REFERENCES `user`(discord_id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
