-- Migration: consolidate_streamer_user
-- Replaces the implicit name-join between `streamer` and `user` with an
-- explicit FK, drops the redundant `streamer.name` column, and enforces
-- one-group-per-streamer via a UNIQUE constraint.
--
-- Run this BEFORE deploying the matching application code.
--
-- STEP 0 — audit duplicates (run first, resolve manually if rows returned):
--   SELECT discord_id, COUNT(*), GROUP_CONCAT(group_id) c
--     FROM (SELECT s.id, u.discord_id, s.group_id
--             FROM streamer s
--             JOIN `user` u ON LOWER(u.twitch_name) = LOWER(s.name)) x
--    GROUP BY discord_id HAVING COUNT(*) > 1;
--
-- STEP 1: add discord_id (nullable while backfilling)
ALTER TABLE streamer ADD COLUMN discord_id BIGINT NULL;

-- STEP 2: backfill from `user` via Twitch name match
UPDATE streamer s
  JOIN `user` u ON LOWER(u.twitch_name) = LOWER(s.name)
  SET s.discord_id = u.discord_id;

-- STEP 3: verify no unmatched rows remain before continuing:
--   SELECT name FROM streamer WHERE discord_id IS NULL;
-- Any rows here have no matching user account — resolve them before step 4.

-- STEP 4: deduplicate multi-group rows — keeps the row with the lowest id.
-- Review and adjust manually if you want to preserve a specific group_id.
DELETE s1 FROM streamer s1
  INNER JOIN streamer s2
          ON s2.discord_id = s1.discord_id
         AND s2.id < s1.id;

-- STEP 5: enforce NOT NULL, add UNIQUE key, add FK
ALTER TABLE streamer MODIFY COLUMN discord_id BIGINT NOT NULL;
ALTER TABLE streamer ADD UNIQUE KEY uq_streamer_discord_id (discord_id);
ALTER TABLE streamer ADD CONSTRAINT fk_streamer_user
  FOREIGN KEY (discord_id) REFERENCES `user`(discord_id) ON DELETE CASCADE;

-- STEP 6: drop the now-redundant name column
ALTER TABLE streamer DROP COLUMN name;
