-- Auto-shoutout raiders: adds an independent toggle that, when enabled, sends a
-- !so-style shoutout for the raiding channel on every incoming raid — separate
-- from (and independent of) the existing raid_enabled welcome-message toggle.

ALTER TABLE streamer_event_config
  ADD COLUMN raid_shoutout_enabled TINYINT(1) NOT NULL DEFAULT 0;
