-- The panel only accepts SFX weights of 1 or more, but rows saved before that check may hold 0 or
-- a negative weight, which the bot has always played as weight 1. Store them as 1 so the data
-- says what actually happens and the app can stop special-casing them. Re-running it is a no-op.
UPDATE sfx SET weight = 1 WHERE weight < 1;
