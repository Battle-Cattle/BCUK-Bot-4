-- Loyalty Points' default earn rates live in one place, src/shared/loyaltyPointsDefaults.ts.
-- Drop the rate columns' DB-level DEFAULTs (left over from the baseline and never used: every
-- write sets all four) so they can't drift from it. DROP DEFAULT is idempotent, so a part-way
-- failure can be fixed and the file re-run.
ALTER TABLE loyalty_points_config
  ALTER COLUMN points_per_message  DROP DEFAULT,
  ALTER COLUMN cooldown_seconds    DROP DEFAULT,
  ALTER COLUMN points_per_sub      DROP DEFAULT,
  ALTER COLUMN points_per_gift_sub DROP DEFAULT;
