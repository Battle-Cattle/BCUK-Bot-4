-- Drop the global user.access_level column. Access levels have been per guild (guild_member)
-- since the baseline, and nothing reads this column any more; the bot only kept writing it.
ALTER TABLE `user` DROP COLUMN access_level;
