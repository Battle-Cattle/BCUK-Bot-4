-- Shared video overlay (#917): videos every connected streamer's shared overlay can play at once,
-- managed by Manager+. Each upload gets a new, never-reused filename, so a URL always means the
-- same file. uploaded_by is provenance only: SET NULL when the uploader's user row goes away.
CREATE TABLE IF NOT EXISTS shared_overlay_video (
  id          INT          NOT NULL AUTO_INCREMENT,
  name        VARCHAR(255) NOT NULL,
  filename    VARCHAR(255) NOT NULL,
  uploaded_by BIGINT       NULL,
  enabled     BOOLEAN      NOT NULL DEFAULT TRUE,
  created_at  TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_shared_overlay_video_filename (filename),
  CONSTRAINT fk_shared_overlay_video_uploader
    FOREIGN KEY (uploaded_by) REFERENCES `user`(discord_id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
