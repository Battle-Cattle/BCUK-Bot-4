-- Migration: consolidate streamer and user tables
--
-- Every streamer is a Discord user. This migration replaces the implicit
-- name-based join (streamer.name = user.twitch_name) with an explicit FK
-- (streamer.discord_id → user.discord_id) and enforces one group per streamer.
--
-- Run in order; check the verification query between steps 3 and 4.

-- Step 1: Add discord_id column (nullable while backfilling)
ALTER TABLE streamer ADD COLUMN discord_id BIGINT NULL;

-- Step 2: Backfill discord_id via the Twitch name match
UPDATE streamer s
JOIN `user` u ON LOWER(u.twitch_name) = LOWER(s.name)
SET s.discord_id = u.discord_id;

-- Step 3: Verify — the following query must return 0 rows before proceeding
-- SELECT name FROM streamer WHERE discord_id IS NULL;

-- Step 4: Deduplicate rows for any streamer that appears in multiple groups.
--         This keeps the row with the lowest id. Audit duplicates first:
--   SELECT discord_id, COUNT(*), GROUP_CONCAT(group_id) AS groups
--   FROM streamer GROUP BY discord_id HAVING COUNT(*) > 1;
DELETE s1 FROM streamer s1
INNER JOIN streamer s2 ON s2.discord_id = s1.discord_id AND s2.id < s1.id;

-- Step 5: Apply NOT NULL, UNIQUE and FK constraints
ALTER TABLE streamer MODIFY COLUMN discord_id BIGINT NOT NULL;
ALTER TABLE streamer ADD UNIQUE KEY uq_streamer_discord_id (discord_id);
ALTER TABLE streamer ADD CONSTRAINT fk_streamer_user
  FOREIGN KEY (discord_id) REFERENCES `user`(discord_id) ON DELETE CASCADE;

-- Step 6: Drop the now-redundant name column
ALTER TABLE streamer DROP COLUMN name;
