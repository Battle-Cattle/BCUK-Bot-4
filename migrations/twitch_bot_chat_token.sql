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
--
-- attempt_started_at orders two independent, concurrently-completing OAuth callbacks (e.g. the
-- owner starting a connect flow from two tabs/devices): it's minted at /admin/bot-auth/connect
-- time (initiation order), not callback-completion time, and saveBotChatTokenIfLatestAttempt()
-- only commits a save whose attempt_started_at is >= the currently stored one — so whichever
-- attempt the owner started *most recently* always wins the row, regardless of which callback's
-- network round trip happens to finish first. See the discussion on PR #666.
CREATE TABLE twitch_bot_chat_token (
  id                  TINYINT      NOT NULL DEFAULT 1,
  twitch_user_id      VARCHAR(50)  NULL,
  access_token        TEXT         NULL, -- AES-256-GCM encrypted, same as streamer.eventsub_access_token
  refresh_token       TEXT         NULL, -- AES-256-GCM encrypted
  token_expiry        BIGINT       NULL, -- Unix milliseconds
  connection_id       BIGINT       NOT NULL DEFAULT 1,
  attempt_started_at  BIGINT       NULL, -- Unix milliseconds; see saveBotChatTokenIfLatestAttempt()
  PRIMARY KEY (id),
  CONSTRAINT chk_twitch_bot_chat_token_singleton CHECK (id = 1)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
