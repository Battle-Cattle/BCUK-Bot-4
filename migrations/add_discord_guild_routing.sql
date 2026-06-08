-- Add per-user Discord guild routing so each streamer's SFX plays in their own server.
-- discord_guild_id: Discord server (guild) snowflake the user's SFX audio should play in.
-- NULL means fall back to the bot-wide DISCORD_GUILD_ID env-var default.
-- The bot resolves which voice channel to use dynamically based on where the user is sitting.
ALTER TABLE `user`
  ADD COLUMN `discord_guild_id` VARCHAR(20) NULL DEFAULT NULL;
