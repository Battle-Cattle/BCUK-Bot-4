import { createLogger } from '../../shared/logger';
import { getDiscordClient } from '../../discord/discordBot';

const log = createLogger('TwitchMonitor');
import { tryEditDiscordMessage } from '../../discord/discordUtils';
import { buildEmbed } from './twitchMonitorEmbed';
import { LiveState, MultiTwitchGroupInfo } from './twitchMonitorTypes';

export type { MultiTwitchGroupInfo };

// ─── Public types ─────────────────────────────────────────────────────────────

export interface MultiTwitchPreview {
  enabled: boolean;
  applicable: boolean;
  participants: string[];
  url: string | null;
}

// ─── Internal types ───────────────────────────────────────────────────────────

interface MultiTwitchContext {
  participantsByGroupAndGame: Map<string, string[]>;
}

// ─── Multitwitch helpers ──────────────────────────────────────────────────────

/**
 * Builds the key used to bucket live states that could co-appear in the same
 * MultiTwitch link: same stream group, same (case-insensitive) game.
 * @param groupId - Stream group ID.
 * @param game - Current game name being played.
 * @returns A composite key combining `groupId` and the lowercased game name.
 */
export function groupGameKey(groupId: number, game: string): string {
  return `${groupId}::${game.toLowerCase()}`;
}

/**
 * Buckets every live state by {@link groupGameKey} to find which streamers
 * within the same group are currently playing the same game (and so are
 * eligible to be linked together in a MultiTwitch URL).
 * @param states - All currently-tracked live states.
 * @returns Context mapping each group+game key to its sorted list of participant logins.
 */
export function buildMultiTwitchContext(states: Iterable<LiveState>): MultiTwitchContext {
  const participantSets = new Map<string, Set<string>>();

  for (const state of states) {
    const key = groupGameKey(state.groupId, state.currentGame);
    const participants = participantSets.get(key);
    if (participants) {
      participants.add(state.login);
    } else {
      participantSets.set(key, new Set([state.login]));
    }
  }

  const participantsByGroupAndGame = new Map<string, string[]>();
  for (const [key, participants] of participantSets.entries()) {
    participantsByGroupAndGame.set(
      key,
      Array.from(participants).sort((participantA, participantB) => participantA.localeCompare(participantB)),
    );
  }

  return { participantsByGroupAndGame };
}

/**
 * Determines the MultiTwitch preview for a single streamer's live state: whether
 * MultiTwitch applies (2+ co-streaming participants on the same game), whether
 * it's enabled for the group, and the resulting URL if both are true.
 * @param state - Live state for the streamer being previewed.
 * @param context - Group+game participant context from {@link buildMultiTwitchContext}.
 * @returns The MultiTwitch preview: enabled/applicable flags, participant logins, and URL (or null).
 */
export function getMultitwitchPreview(state: LiveState, context: MultiTwitchContext): MultiTwitchPreview {
  const participants = context.participantsByGroupAndGame.get(groupGameKey(state.groupId, state.currentGame));
  const applicable = !!participants && participants.length >= 2;

  if (!applicable) {
    return {
      enabled: state.group.multi_twitch,
      applicable: false,
      participants: [state.login],
      url: null,
    };
  }

  if (!state.group.multi_twitch) {
    return {
      enabled: false,
      applicable: true,
      participants,
      url: null,
    };
  }

  const url = `https://www.multitwitch.tv/${participants.join('/')}`;

  return {
    enabled: true,
    applicable: true,
    participants,
    url,
  };
}

/**
 * Refreshes the MultiTwitch field on every live announcement embed in `groupId`
 * to reflect the current set of co-streaming participants. Each announcement is
 * edited independently via {@link tryEditDiscordMessage}, so a Discord not-found
 * error for one streamer's message (deleted, channel gone, etc.) is silently
 * skipped rather than logged — matching the not-found handling already used by
 * the sibling announcement-editing paths in `twitchMonitorAnnouncements.ts` and
 * `twitchMonitorStartup.ts` — while any other error is logged and does not stop
 * the remaining states in the group from being updated.
 *
 * @param groupId - Stream group whose live announcements should be refreshed.
 * @param liveStates - All currently-tracked live states, filtered down to `groupId`.
 */
export async function updateMultitwitch(groupId: number, liveStates: ReadonlyMap<string, LiveState>): Promise<void> {
  const discordClient = getDiscordClient();
  if (!discordClient) return;

  const groupLive = Array.from(liveStates.values()).filter((s) => s.groupId === groupId);
  const context = buildMultiTwitchContext(groupLive);

  for (const state of groupLive) {
    if (!state.messageId || !state.channelId) continue;
    const multiTwitch = getMultitwitchPreview(state, context);
    const multitwitchUrl = multiTwitch.url ?? undefined;
    const updated = buildEmbed(state.currentStream, multitwitchUrl);

    try {
      await tryEditDiscordMessage(discordClient, state.channelId, state.messageId, { embeds: [updated] });
    } catch (err) {
      log.error(`Failed to update multitwitch for ${state.login}:`, err);
    }
  }
}
