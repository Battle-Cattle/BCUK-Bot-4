import { createLogger } from '../shared/logger';
import { normalizeTwitchChannelName } from '../twitch/twitchChannelName';
import { createManagedLookupCache, type RefreshingLookupCache } from './lookupCache';
import { getTwitchEnabledChannels } from './users';
// customCommands imports invalidateCustomCommandLookupCache from this module;
// this module imports getAllCustomCommandsWithAssignments from customCommands.
// Both calls happen inside function bodies, so CommonJS resolves the cycle correctly.
import {
  getAllCustomCommandsWithAssignments,
  type DbCustomCommand,
  type DbCustomCommandWithAssignments,
  type DbCustomCommandAssignedUser,
} from './customCommands';
import { getAllOverrides, type DbGuildCommandOverride } from './guildCommandOverrides';

const log = createLogger('DB');

// ─── Cache interfaces ─────────────────────────────────────────────────────────

interface CustomCommandLookupCache extends RefreshingLookupCache {
  discordByTrigger: Map<string, DbCustomCommand>;
  twitchByChannelAndTrigger: Map<string, DbCustomCommand>;
  // Per-guild Discord overlay on the global catalog: guild_id → (command_id → override).
  // Sparse — only guilds/commands with a deviation appear. Twitch lookups ignore this.
  overridesByGuild: Map<string, Map<number, DbGuildCommandOverride>>;
}

interface TwitchCommandCandidate {
  command: DbCustomCommand;
  source: 'assigned' | 'multi';
  priority: number;
  owner: string;
}

interface TwitchCandidateContext {
  candidateByCacheKey: Map<string, TwitchCommandCandidate>;
}

// ─── Cache builder helpers ────────────────────────────────────────────────────

function createEmptyCustomCommandLookupCache(): CustomCommandLookupCache {
  return {
    // Keep the fallback cache immediately stale so a new refresh can start as soon
    // as the backoff window expires rather than waiting for the normal TTL.
    loadedAt: 0,
    discordByTrigger: new Map<string, DbCustomCommand>(),
    twitchByChannelAndTrigger: new Map<string, DbCustomCommand>(),
    overridesByGuild: new Map<string, Map<number, DbGuildCommandOverride>>(),
  };
}

/** Index a flat list of override rows by guild_id → command_id for O(1) overlay lookups. */
function buildOverridesByGuild(
  overrides: DbGuildCommandOverride[],
): Map<string, Map<number, DbGuildCommandOverride>> {
  const byGuild = new Map<string, Map<number, DbGuildCommandOverride>>();
  for (const override of overrides) {
    let guildMap = byGuild.get(override.guild_id);
    if (!guildMap) {
      guildMap = new Map<number, DbGuildCommandOverride>();
      byGuild.set(override.guild_id, guildMap);
    }
    guildMap.set(override.command_id, override);
  }
  return byGuild;
}

function getTwitchCommandCacheKey(channelName: string, triggerString: string): string | null {
  const normalizedChannelName = normalizeTwitchChannelName(channelName);
  const normalizedTriggerString = triggerString.trim().toLowerCase();

  if (!normalizedChannelName || !normalizedTriggerString) {
    return null;
  }

  return `${normalizedChannelName}::${normalizedTriggerString}`;
}

function normalizeActiveTwitchChannels(activeTwitchChannels: string[]): string[] {
  return activeTwitchChannels
    .map((channel) => normalizeTwitchChannelName(channel))
    .filter((channel): channel is string => channel !== null);
}

function pickPreferredTwitchCandidate(
  existingCandidate: TwitchCommandCandidate,
  nextCandidate: TwitchCommandCandidate,
): TwitchCommandCandidate {
  if (nextCandidate.command.command_id === existingCandidate.command.command_id) {
    return existingCandidate;
  }

  if (nextCandidate.priority !== existingCandidate.priority) {
    return nextCandidate.priority > existingCandidate.priority ? nextCandidate : existingCandidate;
  }

  return nextCandidate.command.command_id < existingCandidate.command.command_id
    ? nextCandidate
    : existingCandidate;
}

function registerDiscordCommand(
  discordByTrigger: Map<string, DbCustomCommand>,
  triggerString: string,
  command: DbCustomCommand,
): void {
  if (!command.is_discord_enabled) {
    return;
  }

  const existingCommand = discordByTrigger.get(triggerString);
  if (existingCommand) {
    log.warn(
      `Custom command Discord trigger collision: '${triggerString}' is already registered ` +
      `(command_id=${existingCommand.command_id}); ignoring duplicate from command_id=${command.command_id}.`,
    );
    return;
  }

  discordByTrigger.set(triggerString, command);
}

function registerTwitchCandidate(
  context: TwitchCandidateContext,
  cacheKey: string,
  triggerString: string,
  channelName: string,
  candidate: TwitchCommandCandidate,
): void {
  const existingCandidate = context.candidateByCacheKey.get(cacheKey);
  if (!existingCandidate) {
    context.candidateByCacheKey.set(cacheKey, candidate);
    return;
  }

  const preferredCandidate = pickPreferredTwitchCandidate(existingCandidate, candidate);
  if (preferredCandidate === existingCandidate) {
    if (existingCandidate.command.command_id === candidate.command.command_id) {
      return;
    }

    log.warn(
      `Custom command Twitch trigger collision: '${triggerString}' in channel '${channelName}'. ` +
      `Already maps to command_id=${existingCandidate.command.command_id} (${existingCandidate.source}:${existingCandidate.owner}); ` +
      `ignoring command_id=${candidate.command.command_id} (${candidate.source}:${candidate.owner}).`,
    );
    return;
  }

  const remapMsg = `Custom command Twitch trigger collision remapped. trigger='${triggerString}' channel='${channelName}' from_command_id=${existingCandidate.command.command_id} from=${existingCandidate.source}:${existingCandidate.owner} to_command_id=${candidate.command.command_id} to=${candidate.source}:${candidate.owner}`;
  if (existingCandidate.priority === candidate.priority) {
    log.warn(remapMsg);
  } else {
    log.info(remapMsg);
  }
  context.candidateByCacheKey.set(cacheKey, preferredCandidate);
}

function registerMultiTwitchCandidates(
  context: TwitchCandidateContext,
  activeChannels: string[],
  triggerString: string,
  command: DbCustomCommand,
  isMultiTwitch: boolean,
): void {
  if (!isMultiTwitch) {
    return;
  }

  for (const activeChannel of activeChannels) {
    const cacheKey = getTwitchCommandCacheKey(activeChannel, triggerString);
    if (!cacheKey) {
      continue;
    }

    registerTwitchCandidate(context, cacheKey, triggerString, activeChannel, {
      command,
      source: 'multi',
      priority: 1,
      owner: 'multi_twitch',
    });
  }
}

function registerAssignedTwitchCandidates(
  context: TwitchCandidateContext,
  assignedUsers: DbCustomCommandAssignedUser[],
  triggerString: string,
  command: DbCustomCommand,
): void {
  for (const assignedUser of assignedUsers) {
    if (!assignedUser.twitch_name || !assignedUser.is_twitch_bot_enabled) {
      continue;
    }

    const cacheKey = getTwitchCommandCacheKey(assignedUser.twitch_name, triggerString);
    if (!cacheKey) {
      continue;
    }

    registerTwitchCandidate(context, cacheKey, triggerString, assignedUser.twitch_name, {
      command,
      source: 'assigned',
      priority: 2,
      owner: assignedUser.discord_id,
    });
  }
}

function buildCustomCommandLookupCache(
  commands: DbCustomCommandWithAssignments[],
  activeTwitchChannels: string[],
  overrides: DbGuildCommandOverride[],
): CustomCommandLookupCache {
  const discordByTrigger = new Map<string, DbCustomCommand>();
  const twitchCandidateByChannelAndTrigger = new Map<string, TwitchCommandCandidate>();
  const sortedCommands = [...commands].sort((left, right) => left.command_id - right.command_id);
  const normalizedActiveTwitchChannels = normalizeActiveTwitchChannels(activeTwitchChannels);
  const twitchCandidateContext: TwitchCandidateContext = {
    candidateByCacheKey: twitchCandidateByChannelAndTrigger,
  };

  for (const command of sortedCommands) {
    const normalizedTriggerString = command.trigger_string.trim().toLowerCase();
    if (!normalizedTriggerString) {
      continue;
    }

    const baseCommand = {
      command_id: command.command_id,
      trigger_string: command.trigger_string,
      output: command.output,
      is_discord_enabled: command.is_discord_enabled,
      is_multi_twitch: command.is_multi_twitch,
    };

    registerDiscordCommand(discordByTrigger, normalizedTriggerString, baseCommand);
    registerMultiTwitchCandidates(
      twitchCandidateContext,
      normalizedActiveTwitchChannels,
      normalizedTriggerString,
      baseCommand,
      command.is_multi_twitch,
    );
    registerAssignedTwitchCandidates(
      twitchCandidateContext,
      command.assigned_users,
      normalizedTriggerString,
      baseCommand,
    );
  }

  const twitchByChannelAndTrigger = new Map<string, DbCustomCommand>();
  for (const [cacheKey, candidate] of twitchCandidateByChannelAndTrigger.entries()) {
    twitchByChannelAndTrigger.set(cacheKey, candidate.command);
  }

  return {
    loadedAt: Date.now(),
    discordByTrigger,
    twitchByChannelAndTrigger,
    overridesByGuild: buildOverridesByGuild(overrides),
  };
}

// ─── Cache state ──────────────────────────────────────────────────────────────

const CACHE_TTL_MS = 300_000;
const CACHE_REFRESH_FAILURE_BACKOFF_MS = 5_000;
const CACHE_REFRESH_FAILURE_MAX_BACKOFF_MS = 60_000;

const customCommandLookupCacheState = createManagedLookupCache<CustomCommandLookupCache>({
  cacheName: 'custom command cache',
  ttlMs: CACHE_TTL_MS,
  refreshFailureBackoffMs: CACHE_REFRESH_FAILURE_BACKOFF_MS,
  refreshFailureMaxBackoffMs: CACHE_REFRESH_FAILURE_MAX_BACKOFF_MS,
  createEmptyCache: createEmptyCustomCommandLookupCache,
  loadCache: async () => {
    const [commands, activeTwitchChannels, overrides] = await Promise.all([
      getAllCustomCommandsWithAssignments(),
      getTwitchEnabledChannels(),
      getAllOverrides(),
    ]);
    return buildCustomCommandLookupCache(commands, activeTwitchChannels, overrides);
  },
});

// ─── Public API ───────────────────────────────────────────────────────────────

export function invalidateCustomCommandLookupCache(): void {
  customCommandLookupCacheState.invalidate();
}

export async function getCustomCommandForTwitchChannel(channelName: string, triggerString: string): Promise<DbCustomCommand | null> {
  const cacheKey = getTwitchCommandCacheKey(channelName, triggerString);
  if (!cacheKey) {
    return null;
  }

  const cache = await customCommandLookupCacheState.getCache();
  const cachedCommand = cache.twitchByChannelAndTrigger.get(cacheKey);
  return cachedCommand ? { ...cachedCommand } : null;
}

/**
 * Resolve a Discord custom command for a guild, applying that guild's override.
 *
 * Resolution: start from the global catalog command; if the guild has an override
 * row for it, `is_disabled` ⇒ the command does not fire (null), and a non-null
 * `output` ⇒ that text replaces the catalog output. No override row ⇒ catalog
 * default. Guilds without any overrides resolve to the plain catalog command.
 *
 * @param triggerString The full prefixed trigger (e.g. `!clap`); matched case-insensitively.
 * @param guildId The guild the message came from (BIGINT snowflake as a string).
 * @returns The (possibly output-substituted) command, or null if absent or disabled.
 */
export async function getCustomCommandForDiscord(
  triggerString: string,
  guildId: string,
): Promise<DbCustomCommand | null> {
  const normalizedTriggerString = triggerString.trim().toLowerCase();
  if (!normalizedTriggerString) {
    return null;
  }

  const cache = await customCommandLookupCacheState.getCache();
  const cachedCommand = cache.discordByTrigger.get(normalizedTriggerString);
  if (!cachedCommand) {
    return null;
  }

  const override = cache.overridesByGuild.get(guildId)?.get(cachedCommand.command_id);
  if (override) {
    if (override.is_disabled) {
      return null;
    }
    if (override.output !== null) {
      return { ...cachedCommand, output: override.output };
    }
  }

  return { ...cachedCommand };
}
