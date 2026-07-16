-- Adds six more text animation options (shake, rainbow, flicker, tilt, bounce-in, typewriter)
-- to the alerts overlay's per-event text_animation choice, alongside the original
-- none/wave/pulse/glitch set added by migrations/alert_config_text_animation.sql.
ALTER TABLE alert_config
  MODIFY COLUMN text_animation
    ENUM('none','wave','pulse','glitch','shake','rainbow','flicker','tilt','bounce-in','typewriter')
    NOT NULL DEFAULT 'none';
