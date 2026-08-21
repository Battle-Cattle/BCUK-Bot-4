import { createRuntimeRegistry } from '../commands/twitchRuntime';

/** Runtime contract for resolving which guild a Twitch chat command should target. */
export interface TwitchGuildResolutionRuntime {
  resolveGuildIdForDiscordId: (discordId: string | null) => string | null;
}

// Same runtime-registry pattern as customCommandHandler.ts/counterHandler.ts/etc., used here to
// avoid twitchBot.ts importing directly from discord/voicePresence.ts (which would introduce
// the one direct twitch -> discord dependency in a codebase that otherwise routes every such
// cross-platform call through this DI pattern to keep discord/ and twitch/ decoupled).
const guildResolutionRuntime = createRuntimeRegistry<TwitchGuildResolutionRuntime>();

/**
 * Stores the Discord-side guild-resolution runtime used by `twitchBot.ts`. Call once from
 * `index.ts`, wired to `discord/voicePresence.ts`'s `resolveGuildIdForDiscordId`, before the
 * Twitch bot starts.
 */
export function registerTwitchGuildResolutionRuntime(runtime: TwitchGuildResolutionRuntime): void {
  guildResolutionRuntime.register(runtime);
}

/**
 * Resolves which guild a Twitch chat command targeting `discordId` should route to, via the
 * registered runtime. Returns null if `discordId` is null, or if the runtime hasn't been
 * registered yet — the same "not ready yet, no-op" behavior every other runtime-registry
 * consumer falls back to.
 * @param discordId - Discord snowflake to resolve a target guild for, or null if unresolved.
 * @returns The guild ID the user is currently in voice in, or null.
 */
export function resolveGuildIdForDiscordId(discordId: string | null): string | null {
  if (!discordId) return null;
  return guildResolutionRuntime.get()?.resolveGuildIdForDiscordId(discordId) ?? null;
}
