-- Twitch EventSub: per-streamer OAuth tokens and notification config
-- Run after the base schema is in place.

ALTER TABLE streamer
  ADD COLUMN twitch_user_id VARCHAR(50) NULL,
  ADD COLUMN eventsub_access_token TEXT NULL,
  ADD COLUMN eventsub_refresh_token TEXT NULL,
  ADD COLUMN eventsub_token_expiry BIGINT NULL;

CREATE TABLE streamer_event_config (
  streamer_id         INT PRIMARY KEY,
  -- Follows (requires broadcaster OAuth)
  follow_enabled      TINYINT(1) NOT NULL DEFAULT 0,
  follow_message      VARCHAR(500) NOT NULL DEFAULT 'Thanks {display_name} for the follow!',
  -- Subs/resubs/gifts (requires broadcaster OAuth)
  sub_enabled         TINYINT(1) NOT NULL DEFAULT 0,
  sub_message         VARCHAR(500) NOT NULL DEFAULT 'Thanks {display_name} for subscribing! (Tier {tier_name})',
  resub_message       VARCHAR(500) NOT NULL DEFAULT 'Thanks {display_name} for {months} months! (Tier {tier_name})',
  giftsub_message     VARCHAR(500) NOT NULL DEFAULT '{gifter_display} gifted {count} sub(s) to the community!',
  -- Raids (app token — no OAuth needed)
  raid_enabled        TINYINT(1) NOT NULL DEFAULT 0,
  raid_message        VARCHAR(500) NOT NULL DEFAULT 'Welcome raiders from {from_channel}! Thank you for the {viewers} person raid!',
  FOREIGN KEY (streamer_id) REFERENCES streamer(id) ON DELETE CASCADE
);
