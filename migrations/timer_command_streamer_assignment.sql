-- Migration: timer commands become assignable to multiple streamers
--
-- timer_command was previously self-service, owned by exactly one streamer
-- (streamer_id). Timers are now a Manager-only catalog, like custom_command:
-- each timer is assigned to zero or more Twitch-linked Discord users via a
-- new join table, timer_command_streamer, mirroring custom_command's
-- twitch_user_commands. Existing single-owner rows are backfilled into the
-- join table before the old column is dropped.

CREATE TABLE IF NOT EXISTS timer_command_streamer (
  timer_id   INT    NOT NULL,
  discord_id BIGINT NOT NULL,
  PRIMARY KEY (timer_id, discord_id),
  FOREIGN KEY (timer_id)   REFERENCES timer_command(id) ON DELETE CASCADE,
  FOREIGN KEY (discord_id) REFERENCES `user`(discord_id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Column may already be gone on a re-run — guard the backfill and drop below
-- so this migration is safe to run more than once.
SET @streamer_id_exists = (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'timer_command' AND COLUMN_NAME = 'streamer_id'
);

-- Backfill: each existing timer's sole owner becomes its first assignment. The NOT EXISTS guard
-- (rather than INSERT IGNORE) makes a re-run idempotent without downgrading unrelated errors
-- (a foreign-key violation, a truncated value) to a silently-ignored warning.
SET @sql = IF(@streamer_id_exists = 0,
  'SELECT ''nothing to backfill''',
  'INSERT INTO timer_command_streamer (timer_id, discord_id)
   SELECT tc.id, s.discord_id FROM timer_command tc JOIN streamer s ON s.id = tc.streamer_id
   WHERE NOT EXISTS (
     SELECT 1 FROM timer_command_streamer tcs WHERE tcs.timer_id = tc.id AND tcs.discord_id = s.discord_id
   )');
PREPARE _s FROM @sql; EXECUTE _s; DEALLOCATE PREPARE _s;

-- Drop the old single-owner column and its FK. It was never given an explicit
-- name in schema.sql, so MySQL auto-generated one — look it up rather than
-- guessing it, same approach as streamdeck_multi_guild.sql.
SET @streamer_id_fk = (
  SELECT CONSTRAINT_NAME FROM information_schema.KEY_COLUMN_USAGE
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'timer_command'
    AND COLUMN_NAME = 'streamer_id' AND REFERENCED_TABLE_NAME IS NOT NULL
  LIMIT 1
);

SET @sql = IF(@streamer_id_exists = 0,
  'SELECT ''nothing to drop''',
  CONCAT(
    'ALTER TABLE timer_command ',
    IF(@streamer_id_fk IS NOT NULL, CONCAT('DROP FOREIGN KEY `', @streamer_id_fk, '`, '), ''),
    'DROP COLUMN streamer_id'
  ));
PREPARE _s FROM @sql; EXECUTE _s; DEALLOCATE PREPARE _s;
