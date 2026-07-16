-- Adds a choice of on-screen text animation for the alerts overlay, applied to the alert's
-- message text in the browser source. Independent of enabled/message/duration/assets.
ALTER TABLE alert_config
  ADD COLUMN text_animation ENUM('none','wave','pulse','glitch') NOT NULL DEFAULT 'none';
