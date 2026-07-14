import { DbStreamGroup, DbStreamerFull } from '../../db';
import { TwitchStream } from '../twitchApi';

export interface LiveState {
  streamerId: number;
  groupId: number;
  group: DbStreamGroup;
  login: string;
  messageId: string | null;
  channelId: string | null;
  currentGame: string;
  title: string;
  currentStream: TwitchStream;
  offlineTimer: ReturnType<typeof setTimeout> | null;
}

export function makeLiveState(
  streamer: DbStreamerFull,
  stream: TwitchStream,
  messageId: string | null,
  channelId: string | null,
): LiveState {
  return {
    streamerId: streamer.id,
    groupId: streamer.group.id,
    group: streamer.group,
    login: stream.user_login.toLowerCase(),
    messageId,
    channelId,
    currentGame: stream.game_name,
    title: stream.title,
    currentStream: stream,
    offlineTimer: null,
  };
}

/**
 * A `Map<string, LiveState>` keyed by streamer DB row id, that also maintains a private
 * `login -> key` index so a state can be looked up by its (lowercased) Twitch login in O(1)
 * instead of a linear scan over every entry. Structurally compatible with plain
 * `Map<string, LiveState>` — every other module's `.get`/`.has`/`.values()`/`.entries()` calls
 * keep working unchanged; only `getByLogin` is new.
 */
export class LiveStateMap extends Map<string, LiveState> {
  private readonly loginIndex = new Map<string, string>();

  /**
   * Sets the entry for `key`, keeping the login index in sync: cleans up `key`'s previous
   * login (if any), and evicts any stale entry under a *different* key that previously held
   * `value.login` — so a login can never resolve to two `Map` entries, even if the caller
   * moves a login to a new key without an intervening `delete()`.
   * @param key Streamer DB row id.
   * @param value Live state to store; `value.login` becomes the login index's target for `key`.
   * @returns This map, per the standard `Map.set` contract.
   */
  override set(key: string, value: LiveState): this {
    const existingAtKey = this.get(key);
    if (existingAtKey && existingAtKey.login !== value.login && this.loginIndex.get(existingAtKey.login) === key) {
      this.loginIndex.delete(existingAtKey.login);
    }

    const previousKeyForLogin = this.loginIndex.get(value.login);
    if (previousKeyForLogin !== undefined && previousKeyForLogin !== key) {
      super.delete(previousKeyForLogin);
    }

    super.set(key, value);
    this.loginIndex.set(value.login, key);
    return this;
  }

  /**
   * Deletes the entry for `key`, removing its login index entry if the index still points at
   * `key` (it may not, if a later `set()` already moved that login to a different key).
   * @param key Streamer DB row id to remove.
   * @returns True if an entry for `key` existed and was removed, per the standard `Map.delete` contract.
   */
  override delete(key: string): boolean {
    const existing = this.get(key);
    if (existing && this.loginIndex.get(existing.login) === key) {
      this.loginIndex.delete(existing.login);
    }
    return super.delete(key);
  }

  /** Clears both the map and the login index. */
  override clear(): void {
    super.clear();
    this.loginIndex.clear();
  }

  /** Looks up the live state for a (lowercased) Twitch login in O(1), or undefined if not live. */
  getByLogin(login: string): LiveState | undefined {
    const key = this.loginIndex.get(login);
    return key === undefined ? undefined : this.get(key);
  }
}
