import { getStatus, type ChannelStatus } from '../shared/statusStore';
import { getGuildById, getGuildMemberUsers } from '../db';
import { normalizeTwitchChannelName } from '../twitch/twitchChannelName';

/** Bot status scoped to a single guild — safe to send to that guild's dashboard viewers. */
export interface GuildScopedStatus {
  discord: { ready: boolean; tag: string | null; guildName: string | null };
  voice: ReturnType<typeof getStatus>['voice'];
  twitch: Record<string, ChannelStatus>;
  tiktok: Record<string, ChannelStatus>;
}

/**
 * Returns the bot status for `guildId`'s dashboard: the guild's own name (never another
 * guild's), voice status for the guild (already scoped by `statusStore.getStatus`), and
 * Twitch channels filtered to just this guild's members. TikTok channels come only from a
 * global env-configured list with no guild association anywhere in the schema, so they're
 * always omitted here rather than guessed or leaked to every guild.
 *
 * @param guildId - Guild to scope the snapshot to, or null if no guild is selected (e.g. an
 *   anonymous dashboard visitor) — returns a snapshot with no guild name and no Twitch/TikTok
 *   channels, without any DB lookup.
 */
export async function getGuildScopedStatus(guildId: string | null): Promise<GuildScopedStatus> {
  const status = getStatus(guildId);

  if (!guildId) {
    return {
      discord: { ...status.discord, guildName: null },
      voice: status.voice,
      twitch: {},
      tiktok: {},
    };
  }

  const [guild, members] = await Promise.all([
    getGuildById(guildId),
    getGuildMemberUsers(guildId),
  ]);

  const allowedTwitchChannels = new Set(
    members
      .filter((m) => m.is_twitch_bot_enabled && m.twitch_name)
      .map((m) => normalizeTwitchChannelName(m.twitch_name as string))
      .filter((v): v is string => v !== null),
  );

  return {
    discord: { ...status.discord, guildName: guild?.name ?? null },
    voice: status.voice,
    twitch: Object.fromEntries(
      Object.entries(status.twitch).filter(([channel]) => allowedTwitchChannels.has(channel)),
    ),
    tiktok: {},
  };
}
