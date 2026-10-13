import { normalizeTwitchChannelName } from '../twitch/twitchChannelName';
import {
  createManagedLookupCache,
  registerFirstWinsWithWarning,
  type RefreshingLookupCache,
  DEFAULT_CACHE_TTL_MS,
  DEFAULT_REFRESH_FAILURE_BACKOFF_MS,
  DEFAULT_REFRESH_FAILURE_MAX_BACKOFF_MS,
} from './lookupCache';
import { normalizeCommand } from './commandStringUtils';
import {
  getAllCustomCommandsWithAssignments,
  type DbCustomCommand,
  type DbCustomCommandWithAssignments,
  type DbCustomCommandAssignedUser,
} from './customCommands';
import { getAllOverrides, type DbGuildCommandOverride } from './guildCommandOverrides';

// ─── Cache interfaces ─────────────────────────────────────────────────────────

interface CustomCommandLookupCache extends RefreshingLookupCache {
  discordByTrigger: Map<string, DbCustomCommand>;
  twitchByChannelAndTrigger: Map<string, DbCustomCommand>;
  // Per-guild Discord overlay on the global catalog: guild_id → (command_id → override).
  // Sparse — only guilds/commands with a deviation appear. Twitch lookups ignore this.
  overridesByGuild: Map<string, Map<number, DbGuildCommandOverride>>;
}

// ─── Cache builder helpers ────────────────────────────────────────────────────

/**
 * Creates an empty, already-stale custom command lookup cache used as the initial/fallback
 * state before the first successful refresh.
 * @returns An empty `CustomCommandLookupCache` with `loadedAt` set to 0.
 */
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

/**
 * Builds the cache key used to look up a Twitch custom command, combining the normalized
 * channel name and trigger string.
 * @param channelName Twitch channel name to normalize.
 * @param triggerString Trigger string to normalize.
 * @returns The composite cache key, or null if either input normalizes to nothing.
 */
function getTwitchCommandCacheKey(channelName: string, triggerString: string): string | null {
  const normalizedChannelName = normalizeTwitchChannelName(channelName);
  const normalizedTriggerString = normalizeCommand(triggerString);

  if (!normalizedChannelName || !normalizedTriggerString) {
    return null;
  }

  return `${normalizedChannelName}::${normalizedTriggerString}`;
}

/**
 * Registers a Discord-enabled command under its trigger string, logging and skipping on collision
 * with an already-registered command. No-ops if the command isn't Discord-enabled.
 * @param discordByTrigger Map being built from trigger string to command.
 * @param triggerString Normalized trigger string to register under.
 * @param command Command to register.
 */
function registerDiscordCommand(
  discordByTrigger: Map<string, DbCustomCommand>,
  triggerString: string,
  command: DbCustomCommand,
): void {
  if (!command.is_discord_enabled) {
    return;
  }

  registerFirstWinsWithWarning(
    discordByTrigger,
    triggerString,
    command,
    (existingCommand) =>
      `Custom command Discord trigger collision: '${triggerString}' is already registered ` +
      `(command_id=${existingCommand.command_id}); ignoring duplicate from command_id=${command.command_id}.`,
  );
}

/**
 * Registers a command on each assigned user's Twitch channel, skipping users without a Twitch
 * name or with Twitch bot disabled. This is the only way a command reaches a Twitch channel,
 * multi-Twitch ones included: a multi-Twitch command fires (and broadcasts) only on the channels
 * of streamers it's assigned to, so a streamer can opt out by unassigning. Commands arrive in
 * ascending `command_id` order, so on a channel+trigger collision the lower id (registered
 * first) wins and the duplicate is logged and skipped.
 * @param twitchByChannelAndTrigger Map being built from channel+trigger cache key to command.
 * @param assignedUsers Users the command is individually assigned to.
 * @param triggerString Normalized trigger string.
 * @param command Command to register.
 */
function registerAssignedTwitchCommands(
  twitchByChannelAndTrigger: Map<string, DbCustomCommand>,
  assignedUsers: DbCustomCommandAssignedUser[],
  triggerString: string,
  command: DbCustomCommand,
): void {
  for (const assignedUser of assignedUsers) {
    if (!assignedUser.twitch_name || !assignedUser.is_twitch_bot_enabled) {
      continue;
    }

    const channelName = assignedUser.twitch_name;
    const cacheKey = getTwitchCommandCacheKey(channelName, triggerString);
    if (!cacheKey) {
      continue;
    }

    registerFirstWinsWithWarning(
      twitchByChannelAndTrigger,
      cacheKey,
      command,
      (existingCommand) =>
        `Custom command Twitch trigger collision: '${triggerString}' in channel '${channelName}' is already registered ` +
        `(command_id=${existingCommand.command_id}); ignoring duplicate from command_id=${command.command_id} ` +
        `(assigned to ${assignedUser.discord_id}).`,
    );
  }
}

/**
 * Builds the full custom command lookup cache: indexes Discord-enabled commands by trigger,
 * registers each command on its assigned users' Twitch channels (multi-Twitch commands
 * included), and indexes per-guild overrides. Commands are
 * processed in ascending `command_id` order so collisions resolve deterministically.
 * @param commands All custom commands with their assigned users.
 * @param overrides All per-guild command overrides.
 * @returns The populated `CustomCommandLookupCache`.
 */
function buildCustomCommandLookupCache(
  commands: DbCustomCommandWithAssignments[],
  overrides: DbGuildCommandOverride[],
): CustomCommandLookupCache {
  const discordByTrigger = new Map<string, DbCustomCommand>();
  const twitchByChannelAndTrigger = new Map<string, DbCustomCommand>();
  const sortedCommands = [...commands].sort((left, right) => left.command_id - right.command_id);

  for (const command of sortedCommands) {
    const normalizedTriggerString = normalizeCommand(command.trigger_string);
    if (!normalizedTriggerString) {
      continue;
    }

    // Frozen once here (not copied per-lookup in getCustomCommandFor*) since callers only ever
    // read this object; freezing turns any future accidental mutation into a loud failure
    // instead of silently corrupting the shared cache entry. Shared by reference across
    // discordByTrigger and every Twitch channel+trigger cache key that resolves to this command.
    const baseCommand = Object.freeze({
      command_id: command.command_id,
      trigger_string: command.trigger_string,
      output: command.output,
      is_discord_enabled: command.is_discord_enabled,
      is_multi_twitch: command.is_multi_twitch,
    });

    registerDiscordCommand(discordByTrigger, normalizedTriggerString, baseCommand);
    registerAssignedTwitchCommands(
      twitchByChannelAndTrigger,
      command.assigned_users,
      normalizedTriggerString,
      baseCommand,
    );
  }

  return {
    loadedAt: Date.now(),
    discordByTrigger,
    twitchByChannelAndTrigger,
    overridesByGuild: buildOverridesByGuild(overrides),
  };
}

// ─── Cache state ──────────────────────────────────────────────────────────────

const customCommandLookupCacheState = createManagedLookupCache<CustomCommandLookupCache>({
  cacheName: 'custom command cache',
  ttlMs: DEFAULT_CACHE_TTL_MS,
  refreshFailureBackoffMs: DEFAULT_REFRESH_FAILURE_BACKOFF_MS,
  refreshFailureMaxBackoffMs: DEFAULT_REFRESH_FAILURE_MAX_BACKOFF_MS,
  createEmptyCache: createEmptyCustomCommandLookupCache,
  loadCache: async () => {
    const [commands, overrides] = await Promise.all([
      getAllCustomCommandsWithAssignments(),
      getAllOverrides(),
    ]);
    return buildCustomCommandLookupCache(commands, overrides);
  },
});

// ─── Public API ───────────────────────────────────────────────────────────────

/** Marks the custom command lookup cache as stale so the next read triggers a refresh. */
export function invalidateCustomCommandLookupCache(): void {
  customCommandLookupCacheState.invalidate();
}

/**
 * Looks up the custom command that fires for a trigger string on a given Twitch channel.
 * @param channelName Twitch channel the message came from.
 * @param triggerString Trigger string to match, matched case-insensitively.
 * @returns The matching command, or null if none matches or either input is invalid.
 */
export async function getCustomCommandForTwitchChannel(channelName: string, triggerString: string): Promise<DbCustomCommand | null> {
  const cacheKey = getTwitchCommandCacheKey(channelName, triggerString);
  if (!cacheKey) {
    return null;
  }

  const cache = await customCommandLookupCacheState.getCache();
  return cache.twitchByChannelAndTrigger.get(cacheKey) ?? null;
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
  const normalizedTriggerString = normalizeCommand(triggerString);
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

  return cachedCommand;
}
