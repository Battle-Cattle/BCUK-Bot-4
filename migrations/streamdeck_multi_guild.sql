-- Streamdeck multi-guild support.
--
-- Splits streamdeck_api_keys (one row = one user, one key, one bound guild)
-- into an identity table (one key per user, no guild binding) plus a new
-- streamdeck_key_guild_status table holding independent per-guild approval
-- state for that same key. This lets a single Streamdeck API key be approved
-- for — and act on — more than one guild.
--
-- Safe to run once against a deployment that already has streamdeck_api_keys
-- in the pre-split shape (guild_id/status/requested_at/approved_at/approved_by
-- columns present). Guarded behind an existence check since the table may be
-- absent on some deployments.
--
-- streamdeck_key_guild_status.discord_id is declared VARCHAR(64) (matching
-- utf8mb4_0900_ai_ci) rather than the BIGINT schema.sql documents for `user`
-- and `guild` — some deployments' streamdeck_api_keys.discord_id predates the
-- BIGINT convention and is still VARCHAR(64); MySQL's FK type/collation check
-- (error 3780) requires an exact match to whatever streamdeck_api_keys
-- actually has. Run `SHOW CREATE TABLE streamdeck_api_keys` first if unsure.

SET @sd_exists = (
  SELECT COUNT(*) FROM information_schema.tables
  WHERE table_schema = DATABASE() AND table_name = 'streamdeck_api_keys'
);

SET @already_split = (
  SELECT COUNT(*) FROM information_schema.columns
  WHERE table_schema = DATABASE() AND table_name = 'streamdeck_api_keys' AND column_name = 'guild_id'
);

-- ─── streamdeck_key_guild_status ────────────────────────────────────────────
SET @sql = IF(@sd_exists = 0,
  'SELECT ''streamdeck_api_keys absent — skipping streamdeck multi-guild migration''',
  'CREATE TABLE IF NOT EXISTS streamdeck_key_guild_status (
     discord_id   VARCHAR(64) COLLATE utf8mb4_0900_ai_ci       NOT NULL,
     guild_id     BIGINT                                       NOT NULL,
     status       ENUM(''pending'',''approved'',''revoked'',''denied'') NOT NULL DEFAULT ''pending'',
     requested_at DATETIME                                     NOT NULL,
     approved_at  DATETIME                                     NULL,
     approved_by  BIGINT                                       NULL,
     PRIMARY KEY (discord_id, guild_id),
     FOREIGN KEY (discord_id) REFERENCES streamdeck_api_keys(discord_id) ON DELETE CASCADE,
     FOREIGN KEY (guild_id)   REFERENCES guild(guild_id)                 ON DELETE CASCADE,
     FOREIGN KEY (approved_by) REFERENCES `user`(discord_id) ON DELETE SET NULL
   ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci');
PREPARE _s FROM @sql; EXECUTE _s; DEALLOCATE PREPARE _s;

-- Carry each existing (discord_id, guild_id) binding + approval state over
-- as its own row — a straightforward 1-to-1 split of the old data model.
-- Upsert (rather than INSERT IGNORE) makes this both resumable and safe to
-- re-run: a run that fails after this step but before the DROP COLUMN step
-- below leaves guild_id in place, so a re-run refreshes the already-backfilled
-- rows' status/approval fields from streamdeck_api_keys instead of silently
-- skipping them (which would leave stale data if it changed between runs).
SET @sql = IF(@sd_exists = 0 OR @already_split = 0,
  'SELECT ''nothing to backfill''',
  'INSERT INTO streamdeck_key_guild_status
     (discord_id, guild_id, status, requested_at, approved_at, approved_by)
   SELECT discord_id, guild_id, status, requested_at, approved_at, approved_by
   FROM streamdeck_api_keys AS src
   ON DUPLICATE KEY UPDATE
     status = src.status,
     requested_at = src.requested_at,
     approved_at = src.approved_at,
     approved_by = src.approved_by');
PREPARE _s FROM @sql; EXECUTE _s; DEALLOCATE PREPARE _s;

-- ─── streamdeck_api_keys: drop the old per-guild columns ───────────────────
-- Guarded the same way as the approved_by FK lookup below: a run that fails
-- after adding created_at but before the DROP COLUMN step leaves guild_id in
-- place (so @already_split is still 1), and a re-run would otherwise hit
-- "Duplicate column name 'created_at'".
SET @created_at_exists = (
  SELECT COUNT(*) FROM information_schema.columns
  WHERE table_schema = DATABASE() AND table_name = 'streamdeck_api_keys' AND column_name = 'created_at'
);

SET @sql = IF(@sd_exists = 0 OR @already_split = 0 OR @created_at_exists = 1,
  'SELECT ''nothing to add''',
  'ALTER TABLE streamdeck_api_keys
     ADD COLUMN created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP');
PREPARE _s FROM @sql; EXECUTE _s; DEALLOCATE PREPARE _s;

-- This UPDATE intentionally has no WHERE clause — every row needs its
-- created_at backfilled — which trips SQL_SAFE_UPDATES if a client (e.g.
-- MySQL Workbench) has it enabled by default. Disable it for this statement
-- only and restore it immediately after.
SET @prior_safe_updates = @@SESSION.sql_safe_updates;
SET SQL_SAFE_UPDATES = 0;
SET @sql = IF(@sd_exists = 0 OR @already_split = 0,
  'SELECT ''nothing to backfill for created_at''',
  'UPDATE streamdeck_api_keys SET created_at = requested_at');
PREPARE _s FROM @sql; EXECUTE _s; DEALLOCATE PREPARE _s;
SET SQL_SAFE_UPDATES = @prior_safe_updates;

-- Some deployments' streamdeck_api_keys has an approved_by FK (`FOREIGN KEY
-- (approved_by) REFERENCES user(discord_id) ON DELETE SET NULL`); others have
-- none at all. Where it exists it was never given an explicit name in
-- schema.sql, so MySQL auto-generated one (e.g. streamdeck_api_keys_ibfk_2).
-- DROP COLUMN approved_by fails with error 1553 unless that constraint is
-- dropped first — look its name up rather than guessing (or assuming) it.
SET @approved_by_fk = (
  SELECT CONSTRAINT_NAME FROM information_schema.KEY_COLUMN_USAGE
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'streamdeck_api_keys'
    AND COLUMN_NAME = 'approved_by' AND REFERENCED_TABLE_NAME IS NOT NULL
  LIMIT 1
);

SET @sql = IF(@sd_exists = 0 OR @already_split = 0,
  'SELECT ''nothing to drop''',
  CONCAT(
    'ALTER TABLE streamdeck_api_keys ',
    'DROP FOREIGN KEY fk_streamdeck_guild, ',
    IF(@approved_by_fk IS NOT NULL, CONCAT('DROP FOREIGN KEY `', @approved_by_fk, '`, '), ''),
    'DROP COLUMN guild_id, ',
    'DROP COLUMN status, ',
    'DROP COLUMN requested_at, ',
    'DROP COLUMN approved_at, ',
    'DROP COLUMN approved_by'));
PREPARE _s FROM @sql; EXECUTE _s; DEALLOCATE PREPARE _s;
