import { getStatus, type ChannelStatus } from '../shared/statusStore';
import { getGuildById, getGuildMemberUsers, type DbGuild, type DbUser } from '../db';
import { normalizeTwitchChannelName } from '../twitch/twitchChannelName';

/** Bot status scoped to a single guild — safe to send to that guild's dashboard viewers. */
export interface GuildScopedStatus {
  discord: { ready: boolean; tag: string | null; guildName: string | null };
  voice: ReturnType<typeof getStatus>['voice'];
  twitch: Record<string, ChannelStatus>;
}

/** How long a guild's name + member list is cached before being re-fetched. */
const GUILD_INFO_CACHE_TTL_MS = 20_000;

interface CachedGuildInfo {
  guild: DbGuild | null;
  members: DbUser[];
  fetchedAt: number;
}

/**
 * `getGuildScopedStatus` is called on every dashboard status poll (every few seconds) and again
 * on every `pushStatusUpdate` broadcast, but the guild's name and Twitch-enabled member list
 * only change on an admin edit — so this caches that lookup per guild for a short TTL rather
 * than re-querying `guild`/`guild_member` on every call. Deliberately TTL-only (not wired to
 * invalidate on every guild/member write): a few seconds of staleness on a dashboard display is
 * an acceptable tradeoff against touching every guild-name/member-Twitch-settings write path.
 */
const guildInfoCache = new Map<string, CachedGuildInfo>();

/**
 * Guilds with a fetch already in flight — coalesces concurrent cache misses (e.g. a status
 * poll and a `pushStatusUpdate` broadcast landing for the same guild before the first fetch
 * resolves) onto a single pair of `getGuildById`/`getGuildMemberUsers` calls, instead of each
 * caller firing its own.
 */
const guildInfoInFlight = new Map<string, Promise<CachedGuildInfo>>();

/** Test-only: clears the guild-info cache so DB mocks aren't shadowed across test cases. */
export function clearGuildScopedStatusCache(): void {
  guildInfoCache.clear();
  guildInfoInFlight.clear();
}

async function getCachedGuildInfo(guildId: string): Promise<CachedGuildInfo> {
  const cached = guildInfoCache.get(guildId);
  const now = Date.now();
  if (cached && now - cached.fetchedAt < GUILD_INFO_CACHE_TTL_MS) {
    return cached;
  }

  const inFlight = guildInfoInFlight.get(guildId);
  if (inFlight) return inFlight;

  const load = (async (): Promise<CachedGuildInfo> => {
    try {
      const [guild, members] = await Promise.all([
        getGuildById(guildId),
        getGuildMemberUsers(guildId),
      ]);
      const info: CachedGuildInfo = { guild, members, fetchedAt: Date.now() };
      guildInfoCache.set(guildId, info);
      return info;
    } finally {
      guildInfoInFlight.delete(guildId);
    }
  })();
  guildInfoInFlight.set(guildId, load);
  return load;
}

/**
 * Returns the bot status for `guildId`'s dashboard: the guild's own name (never another
 * guild's), voice status for the guild (already scoped by `statusStore.getStatus`), and
 * Twitch channels filtered to just this guild's members.
 *
 * @param guildId - Guild to scope the snapshot to, or null if no guild is selected (e.g. an
 *   anonymous dashboard visitor) — returns a snapshot with no guild name and no Twitch
 *   channels, without any DB lookup.
 */
export async function getGuildScopedStatus(guildId: string | null): Promise<GuildScopedStatus> {
  const status = getStatus(guildId);

  if (!guildId) {
    return {
      discord: { ...status.discord, guildName: null },
      voice: status.voice,
      twitch: {},
    };
  }

  const { guild, members } = await getCachedGuildInfo(guildId);

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
  };
}
