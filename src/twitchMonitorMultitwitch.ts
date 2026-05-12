import { discordClient } from './discordBot';
import { getMonitorEnabled } from './monitorSettings';
import { buildEmbed, fillTemplate } from './twitchMonitorEmbed';
import { LiveState } from './twitchMonitorTypes';

// ─── Public types ─────────────────────────────────────────────────────────────

export interface MultiTwitchPreview {
  enabled: boolean;
  applicable: boolean;
  participants: string[];
  url: string | null;
  renderedFooter: string | null;
}

export interface MultiTwitchGroupInfo {
  url: string;
  participants: string[];
}

// ─── Internal types ───────────────────────────────────────────────────────────

interface MultiTwitchContext {
  participantsByGroupAndGame: Map<string, string[]>;
}

// ─── Multitwitch helpers ──────────────────────────────────────────────────────

export function groupGameKey(groupId: number, game: string): string {
  return `${groupId}::${game.toLowerCase()}`;
}

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

export function getMultitwitchPreview(state: LiveState, context: MultiTwitchContext): MultiTwitchPreview {
  const participants = context.participantsByGroupAndGame.get(groupGameKey(state.groupId, state.currentGame));
  const applicable = !!participants && participants.length >= 2;

  if (!applicable) {
    return {
      enabled: state.group.multi_twitch,
      applicable: false,
      participants: [state.login],
      url: null,
      renderedFooter: null,
    };
  }

  if (!state.group.multi_twitch) {
    return {
      enabled: false,
      applicable: true,
      participants,
      url: null,
      renderedFooter: null,
    };
  }

  const url = `https://www.multitwitch.tv/${participants.join('/')}`;
  const renderedFooter = fillTemplate(state.group.multi_twitch_message, { multitwitch: url }) || null;

  return {
    enabled: true,
    applicable: true,
    participants,
    url,
    renderedFooter,
  };
}

export async function updateMultitwitch(groupId: number, liveStates: ReadonlyMap<string, LiveState>): Promise<void> {
  if (!getMonitorEnabled() || !discordClient) return;

  const groupLive = Array.from(liveStates.values()).filter((s) => s.groupId === groupId);
  const context = buildMultiTwitchContext(groupLive);

  for (const state of groupLive) {
    if (!state.messageId || !state.channelId) continue;
    const multiTwitch = getMultitwitchPreview(state, context);
    const multitwitchUrl = multiTwitch.url ?? undefined;

    try {
      const channel = await discordClient.channels.fetch(state.channelId);
      if (!channel || !channel.isTextBased()) continue;
      const message = await channel.messages.fetch(state.messageId);
      const updated = buildEmbed(state.currentStream, multitwitchUrl);
      await message.edit({ embeds: [updated] });
    } catch (err) {
      console.error(`[TwitchMonitor] Failed to update multitwitch for ${state.login}:`, err);
    }
  }
}
