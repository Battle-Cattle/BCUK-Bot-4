-- Public overlay video library (#907): a streamer adds one of their overlay videos to a library
-- every streamer can browse, and imports library videos as their own overlay_video copies. Each
-- side owns its own file, so the entry outlives the contributor's video and streamer row, and an
-- imported copy outlives the entry. Only an Admin removes an entry.

-- ---------------------------------------------------------------------------
-- overlay_video_library
-- contributor_streamer_id / source_video_id are provenance only: SET NULL when the streamer or
-- their video goes away, and the entry stays. The unique source_video_id stops the same video
-- being added twice while it exists.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS overlay_video_library (
  id                      INT          NOT NULL AUTO_INCREMENT,
  name                    VARCHAR(255) NOT NULL,
  filename                VARCHAR(255) NOT NULL,
  contributor_streamer_id INT          NULL,
  source_video_id         INT          NULL,
  created_at              TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_overlay_video_library_filename (filename),
  UNIQUE KEY uq_overlay_video_library_source (source_video_id),
  CONSTRAINT fk_overlay_video_library_contributor
    FOREIGN KEY (contributor_streamer_id) REFERENCES streamer(id) ON DELETE SET NULL,
  CONSTRAINT fk_overlay_video_library_source
    FOREIGN KEY (source_video_id) REFERENCES overlay_video(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- The library entry a streamer's video was imported from. Provenance only (the "from the public
-- library" and "already added" markers); removing the entry keeps the streamer's copy.
ALTER TABLE overlay_video
  ADD COLUMN library_entry_id INT NULL,
  ADD CONSTRAINT fk_overlay_video_library_entry
    FOREIGN KEY (library_entry_id) REFERENCES overlay_video_library(id) ON DELETE SET NULL;
