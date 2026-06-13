-- BCUK Bot 4 — Full Database Schema
-- MySQL 8.x | utf8mb4 | utf8mb4_unicode_ci
--
-- Creates all tables from scratch for a fresh install.
-- Table order respects foreign key dependencies.
--
-- The migrations/ directory contains scripts for upgrading an existing install.
-- The sessions table is omitted — express-mysql-session creates it automatically.

SET NAMES utf8mb4;
SET FOREIGN_KEY_CHECKS = 0;

-- ---------------------------------------------------------------------------
-- sfxcategory
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS sfxcategory (
  id   INT          NOT NULL AUTO_INCREMENT,
  name VARCHAR(255) NOT NULL,
  PRIMARY KEY (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------------
-- sfxtrigger
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS sfxtrigger (
  id              BIGINT       NOT NULL AUTO_INCREMENT,
  trigger_command VARCHAR(255) NOT NULL,
  category_id     INT          NULL,
  hidden          TINYINT(1)   NOT NULL DEFAULT 0,
  description     VARCHAR(255) NULL,
  PRIMARY KEY (id),
  FOREIGN KEY (category_id) REFERENCES sfxcategory(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------------
-- sfx
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS sfx (
  id              INT          NOT NULL AUTO_INCREMENT,
  trigger_id      BIGINT       NOT NULL,
  file            VARCHAR(255) NOT NULL,
  trigger_command VARCHAR(255) NULL,
  weight          INT          NOT NULL DEFAULT 1,
  hidden          TINYINT(1)   NOT NULL DEFAULT 0,
  category_id     INT          NULL,
  PRIMARY KEY (id),
  FOREIGN KEY (trigger_id)  REFERENCES sfxtrigger(id),
  FOREIGN KEY (category_id) REFERENCES sfxcategory(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------------
-- user
-- twitch_name uniqueness is case-insensitive because the table uses
-- utf8mb4_unicode_ci; blank Twitch names must be stored as NULL, not ''.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS `user` (
  discord_id            BIGINT       NOT NULL,
  discord_name          VARCHAR(255) NULL,
  is_twitch_bot_enabled TINYINT(1)   NOT NULL DEFAULT 0,
  twitch_name           VARCHAR(255) NULL,
  twitchoauth           VARCHAR(512) NULL,
  access_level          INT          NOT NULL DEFAULT 0,  -- deprecated: per-guild level lives in guild_member; dropped in a later migration
  is_owner              TINYINT(1)   NOT NULL DEFAULT 0,  -- global super-admin; set manually in the DB only
  PRIMARY KEY (discord_id),
  UNIQUE KEY uq_user_twitch_name (twitch_name)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------------
-- guild
-- Registry of every Discord server the bot serves, plus per-guild config.
-- Populated automatically by the guildCreate handler.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS guild (
  guild_id         BIGINT       NOT NULL,
  name             VARCHAR(255) NOT NULL DEFAULT '',
  voice_channel_id BIGINT       NULL,
  created_at       TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (guild_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------------
-- guild_member
-- Per-guild access levels (0=User, 1=Mod, 2=Manager, 3=Admin). Replaces the
-- single global user.access_level. No row → access level 0 in that guild.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS guild_member (
  guild_id     BIGINT NOT NULL,
  discord_id   BIGINT NOT NULL,
  access_level INT    NOT NULL DEFAULT 0,
  PRIMARY KEY (guild_id, discord_id),
  FOREIGN KEY (guild_id)   REFERENCES guild(guild_id)    ON DELETE CASCADE,
  FOREIGN KEY (discord_id) REFERENCES `user`(discord_id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------------
-- stream_group
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS stream_group (
  id               INT          NOT NULL AUTO_INCREMENT,
  guild_id         BIGINT       NULL,
  name             VARCHAR(255) NOT NULL,
  discord_channel  BIGINT       NOT NULL,
  live_message     TEXT         NOT NULL,
  new_game_message TEXT         NOT NULL,
  multi_twitch     TINYINT(1)   NOT NULL DEFAULT 0,
  delete_old_posts TINYINT(1)   NOT NULL DEFAULT 0,
  PRIMARY KEY (id),
  INDEX idx_stream_group_guild (guild_id),
  CONSTRAINT fk_stream_group_guild FOREIGN KEY (guild_id) REFERENCES guild(guild_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------------
-- streamer
-- One row per Discord user; Twitch channel name is read from user.twitch_name.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS streamer (
  id                     INT          NOT NULL AUTO_INCREMENT,
  discord_id             BIGINT       NOT NULL,
  group_id               INT          NOT NULL,
  discord_message_id     VARCHAR(20)  NULL,
  discord_channel_id     BIGINT       NULL,
  live_game              VARCHAR(255) NULL,
  twitch_user_id         VARCHAR(50)  NULL,
  eventsub_access_token  TEXT         NULL,
  eventsub_refresh_token TEXT         NULL,
  eventsub_token_expiry  BIGINT       NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_streamer_discord_id (discord_id),
  CONSTRAINT fk_streamer_user  FOREIGN KEY (discord_id) REFERENCES `user`(discord_id) ON DELETE CASCADE,
  CONSTRAINT fk_streamer_group FOREIGN KEY (group_id)   REFERENCES stream_group(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------------
-- streamer_event_config
-- Per-streamer EventSub notification settings and message templates.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS streamer_event_config (
  streamer_id     INT          NOT NULL,
  follow_enabled  TINYINT(1)   NOT NULL DEFAULT 0,
  follow_message  VARCHAR(500) NOT NULL DEFAULT 'Thanks {display_name} for the follow!',
  sub_enabled     TINYINT(1)   NOT NULL DEFAULT 0,
  sub_message     VARCHAR(500) NOT NULL DEFAULT 'Thanks {display_name} for subscribing! (Tier {tier})',
  resub_message   VARCHAR(500) NOT NULL DEFAULT 'Thanks {display_name} for {months} months! (Tier {tier})',
  giftsub_message VARCHAR(500) NOT NULL DEFAULT '{gifter_display} gifted {count} sub(s) to the community!',
  raid_enabled    TINYINT(1)   NOT NULL DEFAULT 0,
  raid_message    VARCHAR(500) NOT NULL DEFAULT 'Welcome raiders from {from_display}! Thank you for the {viewers} person raid!',
  PRIMARY KEY (streamer_id),
  FOREIGN KEY (streamer_id) REFERENCES streamer(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------------
-- custom_command
-- trigger_string is NOT globally unique — the same trigger can exist on
-- different Twitch channels. See DATABASE-SCHEMA.md for details.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS custom_command (
  command_id         INT UNSIGNED NOT NULL AUTO_INCREMENT,
  trigger_string     VARCHAR(255) NOT NULL,
  output             TEXT         NOT NULL,
  is_discord_enabled TINYINT(1)   NOT NULL DEFAULT 0,
  is_multi_twitch    TINYINT(1)   NOT NULL DEFAULT 0,
  PRIMARY KEY (command_id),
  INDEX idx_cc_trigger (trigger_string)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------------
-- twitch_user_commands
-- Maps custom commands to the Discord users (Twitch streamers) they belong to.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS twitch_user_commands (
  command_id INT UNSIGNED NOT NULL,
  discord_id BIGINT       NOT NULL,
  PRIMARY KEY (command_id, discord_id),
  FOREIGN KEY (command_id) REFERENCES custom_command(command_id) ON DELETE CASCADE,
  FOREIGN KEY (discord_id) REFERENCES `user`(discord_id)         ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------------
-- guild_command_override
-- Sparse per-guild overlay on the global custom_command catalog. A row exists
-- only where a guild has disabled a command or replaced its Discord output.
-- No row → catalog default (enabled, catalog output). Twitch ignores this table.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS guild_command_override (
  guild_id    BIGINT       NOT NULL,
  command_id  INT UNSIGNED NOT NULL,
  is_disabled TINYINT(1)   NOT NULL DEFAULT 0,
  output      TEXT         NULL,
  PRIMARY KEY (guild_id, command_id),
  FOREIGN KEY (guild_id)   REFERENCES guild(guild_id)            ON DELETE CASCADE,
  FOREIGN KEY (command_id) REFERENCES custom_command(command_id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------------
-- counter
-- Per-guild. UNIQUEs are scoped to (guild_id, command) so two guilds may share
-- a command string. Cross-column uniqueness is enforced at the application
-- layer via advisory locks and isAnyCommandTakenAcrossTables(). See DATABASE-SCHEMA.md.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS counter (
  id                INT          NOT NULL AUTO_INCREMENT,
  guild_id          BIGINT       NULL,
  trigger_command   VARCHAR(255) NOT NULL,
  check_command     VARCHAR(255) NOT NULL,
  message           TEXT         NOT NULL,
  increment_message TEXT         NOT NULL,
  reset_yearly      TINYINT(1)   NOT NULL DEFAULT 0,
  current_value     INT          NOT NULL DEFAULT 0,
  value2020         INT          NULL,
  value2021         INT          NULL,
  value2022         INT          NULL,
  value2023         INT          NULL,
  value2024         INT          NULL,
  value2025         INT          NULL,
  PRIMARY KEY (id),
  CONSTRAINT uq_counter_guild_trigger UNIQUE (guild_id, trigger_command),
  CONSTRAINT uq_counter_guild_check   UNIQUE (guild_id, check_command),
  CONSTRAINT fk_counter_guild FOREIGN KEY (guild_id) REFERENCES guild(guild_id),
  INDEX idx_counter_trigger (trigger_command),
  INDEX idx_counter_check   (check_command)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------------
-- overlay_video
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS overlay_video (
  id          INT          NOT NULL AUTO_INCREMENT,
  streamer_id INT          NOT NULL,
  name        VARCHAR(255) NOT NULL,
  filename    VARCHAR(255) NOT NULL,
  created_at  TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  FOREIGN KEY (streamer_id) REFERENCES streamer(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------------
-- overlay_reward
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS overlay_reward (
  id               INT          NOT NULL AUTO_INCREMENT,
  streamer_id      INT          NOT NULL,
  twitch_reward_id VARCHAR(255) NOT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_reward (streamer_id, twitch_reward_id),
  FOREIGN KEY (streamer_id) REFERENCES streamer(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------------
-- overlay_reward_video
-- One reward can trigger multiple videos (weighted random, same as SFX).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS overlay_reward_video (
  reward_id INT NOT NULL,
  video_id  INT NOT NULL,
  weight    INT NOT NULL DEFAULT 1,
  PRIMARY KEY (reward_id, video_id),
  FOREIGN KEY (reward_id) REFERENCES overlay_reward(id) ON DELETE CASCADE,
  FOREIGN KEY (video_id)  REFERENCES overlay_video(id)  ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------------
-- streamdeck_api_keys
-- key_hash is a hex-encoded SHA-256 of the plain API key (64 chars).
-- approved_by is nullable; SET NULL if the approver's user row is deleted.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS streamdeck_api_keys (
  discord_id   BIGINT                                       NOT NULL,
  key_hash     VARCHAR(64)                                  NOT NULL,
  guild_id     BIGINT                                       NULL,
  status       ENUM('pending','approved','revoked','denied') NOT NULL DEFAULT 'pending',
  requested_at DATETIME                                     NOT NULL,
  approved_at  DATETIME                                     NULL,
  approved_by  BIGINT                                       NULL,
  PRIMARY KEY (discord_id),
  CONSTRAINT fk_streamdeck_guild FOREIGN KEY (guild_id) REFERENCES guild(guild_id),
  FOREIGN KEY (approved_by) REFERENCES `user`(discord_id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

SET FOREIGN_KEY_CHECKS = 1;
