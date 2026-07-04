-- Time-series log of computed price/demand for the /channel-points admin page's history graph.
-- Bounded to roughly the largest selectable time range (24h) — recordPricingHistory()
-- prunes older rows for the same reward on every insert, so this never grows unbounded.
CREATE TABLE reward_pricing_history (
  id                INT    AUTO_INCREMENT PRIMARY KEY,
  reward_pricing_id INT    NOT NULL,
  recorded_at       BIGINT NOT NULL,
  cost              INT    NOT NULL,
  demand            DECIMAL(9,6) NOT NULL,
  KEY idx_reward_pricing_history_reward_time (reward_pricing_id, recorded_at),
  FOREIGN KEY (reward_pricing_id) REFERENCES reward_pricing(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
