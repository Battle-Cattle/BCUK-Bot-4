-- Persistent marker for the yearly counter archive/reset (counterScheduler.ts).
--
-- archiveAndResetYearlyCounters(year) claims `year` by inserting a row here (INSERT IGNORE) in
-- the same transaction as the archive/reset UPDATE, and skips the UPDATE if the row already
-- exists. That makes the archive idempotent, so the scheduler can attempt the previous year's
-- archive on every hourly tick instead of only on 1 January — a bot that was down for all of
-- 1 January now catches up on its next tick instead of skipping that year's reset entirely.
--
-- SEED: the previous calendar year is inserted as already archived. Without it, deploying this
-- mid-year would make the very next tick archive/reset every reset_yearly counter for last year
-- again (wiping this year's progress into current_value = 0). Last year's archive already ran
-- under the old Jan-1-only scheduler (or was knowingly missed), so it must not run again now.
-- If last year's archive was in fact missed and you DO want it to run now, delete that row
-- after applying this migration.
CREATE TABLE IF NOT EXISTS counter_archive_run (
  archive_year SMALLINT UNSIGNED NOT NULL,
  archived_at  DATETIME          NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (archive_year)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

INSERT IGNORE INTO counter_archive_run (archive_year) VALUES (YEAR(CURDATE()) - 1);
