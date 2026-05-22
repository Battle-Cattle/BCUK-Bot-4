-- Migration: consolidate streamer and user tables
--
-- Every streamer is a Discord user. This migration replaces the implicit
-- name-based join (streamer.name = user.twitch_name) with an explicit FK
-- (streamer.discord_id → user.discord_id) and enforces one group per streamer.
--
-- Run in order. If an error occurs inside the transaction, issue ROLLBACK
-- before resolving the issue and re-running from START TRANSACTION.

-- Step 1: Add discord_id column (nullable while backfilling)
ALTER TABLE streamer ADD COLUMN discord_id BIGINT NULL;

-- Temporary guard procedure — SIGNALs an error if any streamer rows have no
-- matching user after the backfill. Dropped after use.
DROP PROCEDURE IF EXISTS _migration_check_nulls;
DELIMITER //
CREATE PROCEDURE _migration_check_nulls()
BEGIN
  DECLARE cnt INT;
  SELECT COUNT(*) INTO cnt FROM streamer WHERE discord_id IS NULL;
  IF cnt > 0 THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'Aborted: unmatched streamer rows. Check: SELECT name FROM streamer WHERE discord_id IS NULL then re-run from START TRANSACTION.';
  END IF;
END//
DELIMITER ;

-- Steps 2–4 are DML and run inside a transaction so a partial failure is
-- cleanly recoverable. (ALTER TABLE in steps 5–6 auto-commits and cannot
-- be made transactional in MySQL.)
SET SQL_SAFE_UPDATES = 0;
START TRANSACTION;

-- Step 2: Backfill discord_id via the Twitch name match
UPDATE streamer s
JOIN `user` u ON LOWER(u.twitch_name) = LOWER(s.name)
SET s.discord_id = u.discord_id;

-- Step 3: Guard — abort if any rows were not matched.
--         If this signals, issue ROLLBACK before resolving the missing users.
CALL _migration_check_nulls();

-- Step 4: Deduplicate rows for any discord_id that appears in multiple groups,
--         preserving EventSub credentials and config.
--
--         Survivor selection (via window function):
--           • Credentialed rows (twitch_user_id IS NOT NULL) rank first.
--           • Among ties, the lower group_id wins (more senior group assignment).
--
--         Audit before running:
--   SELECT discord_id, COUNT(*), GROUP_CONCAT(id ORDER BY id) AS ids,
--          GROUP_CONCAT(group_id ORDER BY id) AS groups
--   FROM streamer GROUP BY discord_id HAVING COUNT(*) > 1;

-- 4a: Identify the survivor id per duplicate discord_id.
CREATE TEMPORARY TABLE _survivor AS
WITH ranked AS (
  SELECT id, discord_id,
    ROW_NUMBER() OVER (
      PARTITION BY discord_id
      ORDER BY (twitch_user_id IS NULL), group_id ASC
    ) AS rn
  FROM streamer
)
SELECT discord_id, id AS survivor_id
FROM ranked
WHERE rn = 1
  AND discord_id IN (
    SELECT discord_id FROM streamer GROUP BY discord_id HAVING COUNT(*) > 1
  );

-- 4b: Reassociate one non-survivor streamer_event_config to the survivor when
--     the survivor has no config of its own. Using a derived table with MIN()
--     and GROUP BY survivor_id ensures exactly one source row is selected per
--     survivor, preventing a PRIMARY KEY conflict if multiple non-survivors
--     each have a config. The CASCADE in step 4c drops the rest.
UPDATE streamer_event_config sec
JOIN (
  SELECT MIN(sec2.streamer_id) AS src_id, sv.survivor_id
  FROM streamer_event_config sec2
  JOIN streamer s ON s.id = sec2.streamer_id
  JOIN _survivor sv ON sv.discord_id = s.discord_id AND s.id != sv.survivor_id
  WHERE NOT EXISTS (
    SELECT 1 FROM streamer_event_config e WHERE e.streamer_id = sv.survivor_id
  )
  GROUP BY sv.survivor_id
) chosen ON chosen.src_id = sec.streamer_id
SET sec.streamer_id = chosen.survivor_id;

-- 4c: Delete non-survivor rows; cascade removes any remaining orphan configs.
DELETE s FROM streamer s
JOIN _survivor sv ON sv.discord_id = s.discord_id
WHERE s.id != sv.survivor_id;

DROP TEMPORARY TABLE _survivor;

COMMIT;

SET SQL_SAFE_UPDATES = 1;
DROP PROCEDURE IF EXISTS _migration_check_nulls;

-- Step 5: Apply NOT NULL, UNIQUE and FK constraints
ALTER TABLE streamer MODIFY COLUMN discord_id BIGINT NOT NULL;
ALTER TABLE streamer ADD UNIQUE KEY uq_streamer_discord_id (discord_id);
ALTER TABLE streamer ADD CONSTRAINT fk_streamer_user
  FOREIGN KEY (discord_id) REFERENCES `user`(discord_id) ON DELETE CASCADE;

-- Step 6: Drop the now-redundant name column
ALTER TABLE streamer DROP COLUMN name;
