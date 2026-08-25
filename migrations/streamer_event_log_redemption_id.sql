-- Idempotency key for redemption dashboard entries: handleRedemption's retry-from-scratch
-- recovery (see the twitchEventSubHandler.ts redemption-dedup lifecycle) can re-run
-- recordStreamerEvent for the same physical redemption after a later required effect (pricing)
-- fails and the whole redemption is retried. redemption_id lets that retry's INSERT collide on
-- the unique index instead of creating a second dashboard row for one redemption. NULL for the
-- other five event types (follow/sub/resub/giftsub/raid), which have no equivalent natural id —
-- a UNIQUE index permits any number of NULLs, so they're unaffected.
ALTER TABLE streamer_event_log
  ADD COLUMN redemption_id VARCHAR(64) NULL AFTER detail,
  ADD UNIQUE KEY uq_streamer_event_log_redemption (redemption_id);
