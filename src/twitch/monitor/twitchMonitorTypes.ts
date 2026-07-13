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

  override set(key: string, value: LiveState): this {
    const existing = this.get(key);
    if (existing && existing.login !== value.login && this.loginIndex.get(existing.login) === key) {
      this.loginIndex.delete(existing.login);
    }
    super.set(key, value);
    this.loginIndex.set(value.login, key);
    return this;
  }

  override delete(key: string): boolean {
    const existing = this.get(key);
    if (existing && this.loginIndex.get(existing.login) === key) {
      this.loginIndex.delete(existing.login);
    }
    return super.delete(key);
  }

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
