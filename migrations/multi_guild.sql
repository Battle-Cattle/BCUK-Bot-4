-- Multi-server (multi-guild) support — Phase 1 schema migration (PR 1).
--
-- Adds the guild registry, per-guild access levels, the per-guild command
-- override overlay, and guild_id scoping on the per-guild data tables.
--
-- Safe to apply to a running single-guild deployment ahead of the code changes:
-- no application code reads these columns yet, and the new guild_id columns
-- default to the legacy guild, so current INSERTs (which omit guild_id) keep
-- working and land in the legacy guild until the runtime is updated.
--
-- The legacy guild's existing rows are seeded with the current DISCORD_GUILD_ID.
-- `user.access_level` is COPIED into `guild_member` but is NOT dropped here —
-- it is dropped in PR 3 once every reader has migrated to the per-guild level.
--
-- BEFORE RUNNING: set @legacy_guild_id to the value of your DISCORD_GUILD_ID env
-- var, and optionally set @legacy_guild_name to a human-friendly server name.
SET @legacy_guild_id   = 0;            -- <<< REPLACE with your DISCORD_GUILD_ID
SET @legacy_guild_name = 'Legacy Guild';

-- Fail fast if @legacy_guild_id was left at the placeholder. Without this the
-- migration would backfill every guild-scoped row to an invalid guild id (0),
-- requiring manual repair. The unknown-column error surfaces the message text.
SET @sql = IF(@legacy_guild_id IS NULL OR @legacy_guild_id = 0,
  'SELECT `ABORT: set @legacy_guild_id to your DISCORD_GUILD_ID before running this migration` FROM DUAL',
  'SELECT 1');
PREPARE _s FROM @sql; EXECUTE _s; DEALLOCATE PREPARE _s;

-- ─── guild ──────────────────────────────────────────────────────────────────
-- Registry of every Discord server the bot serves, plus per-guild config.
-- Must exist (and be seeded) before any FK references it.
CREATE TABLE guild (
    guild_id         BIGINT       NOT NULL,
    name             VARCHAR(255) NOT NULL DEFAULT '',
    voice_channel_id BIGINT       NULL,          -- replaces the DISCORD_VOICE_CHANNEL_ID env var
    created_at       TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (guild_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

INSERT INTO guild (guild_id, name) VALUES (@legacy_guild_id, @legacy_guild_name);

-- ─── guild_member ───────────────────────────────────────────────────────────
-- Per-guild access levels (0=User, 1=Mod, 2=Manager, 3=Admin). Replaces the
-- single global user.access_level. is_owner (below) is the only cross-guild role.
CREATE TABLE guild_member (
    guild_id     BIGINT NOT NULL,
    discord_id   BIGINT NOT NULL,
    access_level INT    NOT NULL DEFAULT 0,
    PRIMARY KEY (guild_id, discord_id),
    FOREIGN KEY (guild_id)   REFERENCES guild(guild_id)    ON DELETE CASCADE,
    FOREIGN KEY (discord_id) REFERENCES `user`(discord_id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Seed the legacy guild's memberships from the current global access levels.
INSERT INTO guild_member (guild_id, discord_id, access_level)
SELECT @legacy_guild_id, discord_id, access_level FROM `user`;

-- ─── guild_command_override ───────────────────────────────────────────────────
-- Sparse overlay on the GLOBAL custom_command catalog. A row exists only where a
-- guild has deviated: disabled the command, or replaced its Discord output text.
-- No row → catalog default (enabled, catalog output). Twitch is unaffected.
CREATE TABLE guild_command_override (
    guild_id    BIGINT       NOT NULL,
    command_id  INT UNSIGNED NOT NULL,
    is_disabled TINYINT(1)   NOT NULL DEFAULT 0,
    output      TEXT         NULL,
    PRIMARY KEY (guild_id, command_id),
    FOREIGN KEY (guild_id)   REFERENCES guild(guild_id)            ON DELETE CASCADE,
    FOREIGN KEY (command_id) REFERENCES custom_command(command_id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ─── user.is_owner ────────────────────────────────────────────────────────────
-- Global super-admin flag. Set manually in the DB (never via the web panel).
-- access_level is intentionally kept here; it is dropped in PR 3.
ALTER TABLE `user` ADD COLUMN is_owner TINYINT(1) NOT NULL DEFAULT 0;

-- Remember to flag the bot owner(s) afterwards, e.g.:
--   UPDATE `user` SET is_owner = 1 WHERE discord_id = '<OWNER_DISCORD_ID>';

-- ─── counter.guild_id (per-guild) ─────────────────────────────────────────────
-- NOT NULL DEFAULT <legacy guild>: existing rows are backfilled by the default,
-- and current writes (which omit guild_id) keep working and land in the legacy
-- guild until the runtime starts supplying guild_id. Dynamic SQL bakes the
-- operator's guild id in as the literal column default.
SET @sql = CONCAT(
  'ALTER TABLE counter ',
  'ADD COLUMN guild_id BIGINT NOT NULL DEFAULT ', @legacy_guild_id, ' AFTER id, ',
  'ADD CONSTRAINT fk_counter_guild FOREIGN KEY (guild_id) REFERENCES guild(guild_id)');
PREPARE _s FROM @sql; EXECUTE _s; DEALLOCATE PREPARE _s;

-- Global uniqueness on counter command columns is wrong once two guilds exist.
-- Drop the optional global constraints if present, then add per-guild uniqueness.
SET @exists = (
  SELECT COUNT(*) FROM information_schema.statistics
  WHERE table_schema = DATABASE() AND table_name = 'counter'
    AND index_name = 'uq_counter_trigger_command'
);
SET @sql = IF(@exists > 0,
  'ALTER TABLE counter DROP INDEX uq_counter_trigger_command',
  'SELECT ''uq_counter_trigger_command absent''');
PREPARE _s FROM @sql; EXECUTE _s; DEALLOCATE PREPARE _s;

SET @exists = (
  SELECT COUNT(*) FROM information_schema.statistics
  WHERE table_schema = DATABASE() AND table_name = 'counter'
    AND index_name = 'uq_counter_check_command'
);
SET @sql = IF(@exists > 0,
  'ALTER TABLE counter DROP INDEX uq_counter_check_command',
  'SELECT ''uq_counter_check_command absent''');
PREPARE _s FROM @sql; EXECUTE _s; DEALLOCATE PREPARE _s;

ALTER TABLE counter
    ADD CONSTRAINT uq_counter_guild_trigger UNIQUE (guild_id, trigger_command),
    ADD CONSTRAINT uq_counter_guild_check   UNIQUE (guild_id, check_command);

-- ─── stream_group.guild_id (per-guild) ────────────────────────────────────────
-- NOT NULL DEFAULT <legacy guild> for the same write-compatibility reason as counter.
SET @sql = CONCAT(
  'ALTER TABLE stream_group ',
  'ADD COLUMN guild_id BIGINT NOT NULL DEFAULT ', @legacy_guild_id, ' AFTER id, ',
  'ADD INDEX idx_stream_group_guild (guild_id), ',
  'ADD CONSTRAINT fk_stream_group_guild FOREIGN KEY (guild_id) REFERENCES guild(guild_id)');
PREPARE _s FROM @sql; EXECUTE _s; DEALLOCATE PREPARE _s;

-- ─── streamdeck_api_keys.guild_id ─────────────────────────────────────────────
-- A key grants access to one specific guild. PK stays discord_id (one key/user).
-- This table is created outside this repo, so guard the ALTER behind an existence
-- check to avoid a partial migration on environments where it is absent.
SET @sd_exists = (
  SELECT COUNT(*) FROM information_schema.tables
  WHERE table_schema = DATABASE() AND table_name = 'streamdeck_api_keys'
);
SET @sql = IF(@sd_exists = 0,
  'SELECT ''streamdeck_api_keys absent — skipping guild_id add''',
  CONCAT(
    'ALTER TABLE streamdeck_api_keys ',
    'ADD COLUMN guild_id BIGINT NOT NULL DEFAULT ', @legacy_guild_id, ', ',
    'ADD CONSTRAINT fk_streamdeck_guild FOREIGN KEY (guild_id) REFERENCES guild(guild_id)'));
PREPARE _s FROM @sql; EXECUTE _s; DEALLOCATE PREPARE _s;
