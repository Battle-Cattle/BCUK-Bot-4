import { createLogger } from '../shared/logger';
import { getSharedChatSession } from '../twitch/twitchApi';
import { getActiveChannels, getActiveChannelUserIds } from '../twitch/twitchChannelMembership';
import { resolveSharedChatSessionId } from '../commands/customCommandHandler';

const log = createLogger('TriviaGroup');

/**
 * Resolves the trivia round group key for a channel: its live Twitch shared-chat session ID if
 * one exists, otherwise the channel's own login (a "solo" group). Reuses the already-cached
 * {@link resolveSharedChatSessionId} lookup shared with the custom-command/multi-command
 * broadcast dedup, so this is cheap enough to call on every chat message that looks like a
 * trivia answer.
 * @param login - Twitch channel login the message/connection belongs to.
 * @returns The group key: a shared-chat `session_id`, or `login` itself if not in a session.
 */
export async function resolveTriviaGroupKey(login: string): Promise<string> {
  const userId = getActiveChannelUserIds().get(login);
  if (!userId) return login;
  try {
    const sessionId = await resolveSharedChatSessionId(userId);
    return sessionId ?? login;
  } catch (err) {
    log.error(`Failed to resolve shared-chat session for ${login}:`, err);
    return login;
  }
}

/** A channel's trivia round group: its group key plus every other active channel login sharing it. */
export interface TriviaGroup {
  groupKey: string;
  members: string[];
}

/**
 * Resolves a channel's full trivia round group, including which other currently-active channels
 * share its live Twitch shared-chat session — needed so the overlay route knows every login it
 * must fan a round's SSE events out to. Unlike {@link resolveTriviaGroupKey}, this always performs
 * a live (uncached) Helix lookup, since it's only called on overlay connect/disconnect and a
 * periodic reconciliation tick, not per chat message.
 * @param login - Twitch channel login to resolve the group for.
 * @returns The group key and member logins (always includes at least `login` itself).
 */
export async function resolveTriviaGroup(login: string): Promise<TriviaGroup> {
  const userId = getActiveChannelUserIds().get(login);
  if (!userId) return { groupKey: login, members: [login] };

  let session;
  try {
    session = await getSharedChatSession(userId);
  } catch (err) {
    log.error(`Failed to resolve shared-chat session for ${login}:`, err);
    return { groupKey: login, members: [login] };
  }
  if (!session) return { groupKey: login, members: [login] };

  const active = getActiveChannels();
  const members = session.participants
    .map((p) => p.broadcaster_login.toLowerCase())
    .filter((participantLogin) => active.has(participantLogin));

  return { groupKey: session.session_id, members: members.length > 0 ? members : [login] };
}
