-- Customisable alerts overlay: per-streamer, per-event-type alert configuration.
-- Independent of `streamer_event_config` (the existing Twitch-chat message config) and of
-- `overlay_reward`/`overlay_video` (the existing channel-point video overlay) — a streamer
-- may enable a browser-source alert for an event type without enabling the chat message
-- for it, or vice versa.
CREATE TABLE alert_config (
  id               INT AUTO_INCREMENT PRIMARY KEY,
  streamer_id      INT NOT NULL,
  event_type       ENUM('follow','sub','resub','giftsub','raid') NOT NULL,
  enabled          TINYINT(1) NOT NULL DEFAULT 0,
  message_template VARCHAR(500) NOT NULL,
  image_filename   VARCHAR(255) NULL,
  sound_filename   VARCHAR(255) NULL,
  duration_ms      INT NOT NULL DEFAULT 6000,
  UNIQUE KEY uq_alert_config (streamer_id, event_type),
  FOREIGN KEY (streamer_id) REFERENCES streamer(id) ON DELETE CASCADE
);
