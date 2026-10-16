// Runtime injection for advanced commands (see "New Command Handler Pattern" in CLAUDE.md): the
// Twitch chat send, plus a check for whether a streamer's companion app is connected. Registered
// from index.ts, so this layer doesn't import the Twitch bot or the web routes.
import { createRuntimeRegistry } from '../../shared/runtimeRegistry';
import type { TwitchSendRuntime } from '../twitchRuntime';

/** What advanced commands need from the rest of the bot at runtime. */
export interface AdvancedCommandRuntime extends TwitchSendRuntime {
  /** True if the Discord user has at least one companion app connected to the event stream. */
  hasCompanionConnection: (discordId: string) => boolean;
}

export const advancedCommandRuntimeRegistry = createRuntimeRegistry<AdvancedCommandRuntime>();

/**
 * Stores the advanced command runtime. Call once from index.ts before the Twitch bot starts.
 * @param runtime - The runtime to store.
 */
export function registerAdvancedCommandRuntime(runtime: AdvancedCommandRuntime): void {
  advancedCommandRuntimeRegistry.register(runtime);
}
