-- Idempotency guard for dynamic-pricing redemption increments: handleRedemption's retry-from-
-- scratch recovery (see the twitchEventSubHandler.ts redemption-dedup lifecycle) can re-run
-- applyRedemptionPricing for the same physical redemption after a later required effect (the
-- getVideosForReward/overlay lookup) fails and the whole redemption is retried. Without tracking
-- which redemption a reward's demand last accounted for, that retry would double-apply the
-- redemption increment. NULL until a reward's first redemption-driven price sync.
ALTER TABLE reward_pricing
  ADD COLUMN last_redemption_id VARCHAR(64) NULL AFTER last_pushed_cost;
