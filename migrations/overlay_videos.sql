CREATE TABLE overlay_video (
  id          INT AUTO_INCREMENT PRIMARY KEY,
  streamer_id INT          NOT NULL,
  name        VARCHAR(255) NOT NULL,
  filename    VARCHAR(255) NOT NULL,
  created_at  TIMESTAMP    DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (streamer_id) REFERENCES streamer(id) ON DELETE CASCADE
);

CREATE TABLE overlay_reward (
  id               INT          AUTO_INCREMENT PRIMARY KEY,
  streamer_id      INT          NOT NULL,
  twitch_reward_id VARCHAR(255) NOT NULL,
  UNIQUE KEY uq_reward (streamer_id, twitch_reward_id),
  FOREIGN KEY (streamer_id) REFERENCES streamer(id) ON DELETE CASCADE
);

-- One reward can trigger multiple videos (weighted random, same pattern as SFX).
CREATE TABLE overlay_reward_video (
  reward_id INT NOT NULL,
  video_id  INT NOT NULL,
  weight    INT NOT NULL DEFAULT 1,
  PRIMARY KEY (reward_id, video_id),
  FOREIGN KEY (reward_id) REFERENCES overlay_reward(id) ON DELETE CASCADE,
  FOREIGN KEY (video_id)  REFERENCES overlay_video(id)  ON DELETE CASCADE
);
