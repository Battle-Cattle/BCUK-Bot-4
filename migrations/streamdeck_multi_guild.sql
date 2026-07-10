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
     discord_id   BIGINT                                       NOT NULL,
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
-- INSERT IGNORE makes this resumable: a run that fails after this step but
-- before the DROP COLUMN step below leaves guild_id in place, so a re-run
-- would otherwise re-insert already-backfilled rows and hit the primary key.
SET @sql = IF(@sd_exists = 0 OR @already_split = 0,
  'SELECT ''nothing to backfill''',
  'INSERT IGNORE INTO streamdeck_key_guild_status
     (discord_id, guild_id, status, requested_at, approved_at, approved_by)
   SELECT discord_id, guild_id, status, requested_at, approved_at, approved_by
   FROM streamdeck_api_keys');
PREPARE _s FROM @sql; EXECUTE _s; DEALLOCATE PREPARE _s;

-- ─── streamdeck_api_keys: drop the old per-guild columns ───────────────────
SET @sql = IF(@sd_exists = 0 OR @already_split = 0,
  'SELECT ''nothing to drop''',
  'ALTER TABLE streamdeck_api_keys
     ADD COLUMN created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP');
PREPARE _s FROM @sql; EXECUTE _s; DEALLOCATE PREPARE _s;

SET @sql = IF(@sd_exists = 0 OR @already_split = 0,
  'SELECT ''nothing to backfill for created_at''',
  'UPDATE streamdeck_api_keys SET created_at = requested_at');
PREPARE _s FROM @sql; EXECUTE _s; DEALLOCATE PREPARE _s;

-- The old approved_by FK (`FOREIGN KEY (approved_by) REFERENCES user(discord_id)
-- ON DELETE SET NULL`) was never given an explicit name in schema.sql, so MySQL
-- auto-generated one (e.g. streamdeck_api_keys_ibfk_2). DROP COLUMN approved_by
-- fails with error 1553 unless that constraint is dropped first — look its name
-- up rather than guessing it.
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
