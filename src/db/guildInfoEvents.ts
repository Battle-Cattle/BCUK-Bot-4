// A tiny registry telling interested code that what a guild's dashboard shows from the database (its name and its
// Twitch-enabled members) may have changed. The `*Writes.ts` wrappers fire it after a successful write; the raw DB
// modules know nothing about it (see src/db/CLAUDE.md).
import { createLogger } from '../shared/logger';

const log = createLogger('DB');

/** Called when a guild's name or member list may have changed: with that guild's ID, or null when any guild's may have. */
export type GuildInfoListener = (guildId: string | null) => void;

const listeners = new Set<GuildInfoListener>();

/**
 * Registers a listener for guild-info changes. Listeners run synchronously, in registration order, right after the write
 * that changed the data has committed.
 * @param listener - Called with the changed guild's ID, or null when any guild may have changed. Must not return a promise: start async work with `void` and catch its own errors.
 * @returns A function that removes the listener again.
 */
export function onGuildInfoChanged(listener: GuildInfoListener): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/**
 * Tells every listener that a guild's name or member list may have changed. A listener that throws is logged and never
 * stops the others, or rejects the write that has already committed.
 * @param guildId - Discord snowflake of the changed guild, or null when the change can touch any guild (a user-level change: a user can belong to several guilds).
 */
export function notifyGuildInfoChanged(guildId: string | null): void {
  for (const listener of Array.from(listeners)) {
    try {
      listener(guildId);
    } catch (err) {
      log.error('A guild-info change listener threw:', err);
    }
  }
}
