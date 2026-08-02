import { DbStreamGroup, DbStreamerFull } from '../../db';
import { TwitchStream } from '../twitchApi';

/**
 * A group's current MultiTwitch link: the URL and the participant logins it covers. Lives here
 * (rather than in `twitchMonitorMultitwitch.ts`, which imports Discord bot internals) so it can
 * be depended on — e.g. by `commands/customCommandHandler.ts`'s injected runtime — without
 * pulling in that import chain.
 */
export interface MultiTwitchGroupInfo {
  url: string;
  participants: string[];
}

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
 * `login -> key set` index so a state can be looked up by its (lowercased) Twitch login in O(1)
 * instead of a linear scan over every entry. The same Twitch login can legitimately back more
 * than one map entry at once — a streamer can be registered as a streamer in multiple Discord
 * stream groups simultaneously, each with its own DB row id / map key — so the index maps a
 * login to the set of *all* keys currently holding it, not a single key. Structurally
 * compatible with plain `Map<string, LiveState>` — every other module's
 * `.get`/`.has`/`.values()`/`.entries()` calls keep working unchanged; only `getByLogin` is new.
 */
export class LiveStateMap extends Map<string, LiveState> {
  private readonly loginIndex = new Map<string, Set<string>>();

  /**
   * Sets the entry for `key`, keeping the login index in sync: if `key` previously held a
   * *different* login, removes `key` from that old login's key set (pruning the set entirely
   * if it becomes empty), then adds `key` to `value.login`'s key set. Does NOT remove any other
   * key already registered under `value.login` — multiple keys legitimately sharing a login
   * (one per Discord stream group the streamer is registered in) must coexist.
   * @param key Streamer DB row id.
   * @param value Live state to store; `value.login` gains `key` as one of its index targets.
   * @returns This map, per the standard `Map.set` contract.
   */
  override set(key: string, value: LiveState): this {
    const existingAtKey = this.get(key);
    if (existingAtKey && existingAtKey.login !== value.login) {
      const oldLoginKeys = this.loginIndex.get(existingAtKey.login);
      if (oldLoginKeys) {
        oldLoginKeys.delete(key);
        if (oldLoginKeys.size === 0) {
          this.loginIndex.delete(existingAtKey.login);
        }
      }
    }

    let loginKeys = this.loginIndex.get(value.login);
    if (!loginKeys) {
      loginKeys = new Set<string>();
      this.loginIndex.set(value.login, loginKeys);
    }
    loginKeys.add(key);

    super.set(key, value);
    return this;
  }

  /**
   * Deletes the entry for `key`, removing it from its login's key set (pruning the set entirely
   * if it becomes empty as a result).
   * @param key Streamer DB row id to remove.
   * @returns True if an entry for `key` existed and was removed, per the standard `Map.delete` contract.
   */
  override delete(key: string): boolean {
    const existing = this.get(key);
    if (existing) {
      const loginKeys = this.loginIndex.get(existing.login);
      if (loginKeys) {
        loginKeys.delete(key);
        if (loginKeys.size === 0) {
          this.loginIndex.delete(existing.login);
        }
      }
    }
    return super.delete(key);
  }

  /** Clears both the map and the login index. */
  override clear(): void {
    super.clear();
    this.loginIndex.clear();
  }

  /**
   * Looks up a live state for a (lowercased) Twitch login in O(1), or undefined if not live.
   * A login may back multiple map entries at once (one per Discord stream group the streamer is
   * registered in); this returns an arbitrary one of them without disambiguating by group —
   * callers needing a specific group's state should look it up by key (DB row id) instead.
   * @param login Lowercased Twitch login to look up.
   * @returns Any one `LiveState` currently registered under `login`, or undefined if none.
   */
  getByLogin(login: string): LiveState | undefined {
    const keys = this.loginIndex.get(login);
    if (!keys) {
      return undefined;
    }
    const firstKey = keys.values().next().value;
    return firstKey === undefined ? undefined : this.get(firstKey);
  }
}
