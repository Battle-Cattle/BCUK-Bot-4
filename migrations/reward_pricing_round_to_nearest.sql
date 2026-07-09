-- Adds an optional "round to nearest N points" step to dynamic pricing's computed price,
-- per reward. 0 (the default) disables rounding, preserving existing behaviour.
ALTER TABLE reward_pricing
  ADD COLUMN round_to_nearest INT NOT NULL DEFAULT 0 AFTER curve,
  ADD CONSTRAINT chk_reward_pricing_round_to_nearest CHECK (round_to_nearest IN (0, 5, 10));
