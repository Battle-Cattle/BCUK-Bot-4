-- Refreshing OAuth token for the bot's own Twitch chat account (see issue #550).
-- Replaces the static TWITCH_OAUTH_TOKEN env var: this is a single, bot-wide credential
-- (one Twitch account for the bot itself), not per-streamer, so it doesn't belong in the
-- per-streamer `streamer` table alongside the EventSub broadcaster tokens. Single global row
-- (id pinned to 1), same singleton pattern as `pricing_global_settings` in reward_pricing.sql.
-- connection_id increments on every save (initial connect *and* reconnect, same account or not)
-- and is captured by twitchBot.ts's RefreshingAuthProvider when it's built. Its onRefresh/
-- onRefreshFailure handlers use it (not twitch_user_id) as the compare-and-swap key for
-- saveBotChatTokenIfOwnedBy/clearBotChatTokenIfOwnedBy, so a write from a superseded provider is
-- dropped even when the reconnect was to the *same* Twitch account — twitch_user_id alone can't
-- distinguish that case from the still-current connection. See the discussion on PR #666.
CREATE TABLE twitch_bot_chat_token (
  id             TINYINT      NOT NULL DEFAULT 1,
  twitch_user_id VARCHAR(50)  NULL,
  access_token   TEXT         NULL, -- AES-256-GCM encrypted, same as streamer.eventsub_access_token
  refresh_token  TEXT         NULL, -- AES-256-GCM encrypted
  token_expiry   BIGINT       NULL, -- Unix milliseconds
  connection_id  BIGINT       NOT NULL DEFAULT 1,
  PRIMARY KEY (id),
  CONSTRAINT chk_twitch_bot_chat_token_singleton CHECK (id = 1)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
