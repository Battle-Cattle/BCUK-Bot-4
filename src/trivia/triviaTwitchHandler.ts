import tmi from 'tmi.js';
import { createLogger } from '../shared/logger';
import { extractCommand } from '../commands/commandUtils';
import { createRuntimeRegistry, type TwitchSendRuntime } from '../commands/twitchRuntime';
import { resolveTriviaGroupKey } from './triviaSessionGroup';
import { submitAnswer } from './triviaGame';

const log = createLogger('TriviaTwitch');

const ANSWER_PATTERN = /^!(a|b|c|d)$/i;

// ─── Twitch runtime (registered from index.ts before startTwitchBot) ─────────
//
// Same pattern as customCommandHandler.ts/counterHandler.ts to avoid a circular import
// between twitchBot.ts and triviaTwitchHandler.ts.

const triviaRuntime = createRuntimeRegistry<TwitchSendRuntime>();

/** Stores the Twitch chat runtime used to announce trivia round winners. Call once from index.ts after the Twitch bot is ready. */
export function registerTriviaTwitchRuntime(runtime: TwitchSendRuntime): void {
  triviaRuntime.register(runtime);
}

/**
 * Handles a Twitch chat message that may be a trivia answer (`!a`–`!d`): resolves the sending
 * channel's current trivia group (shared with every other channel in the same live Twitch
 * shared-chat session, if any — see `triviaSessionGroup.ts`), submits the answer to
 * {@link submitAnswer}, and announces the win in chat via the registered runtime if it was the
 * first correct answer for the round.
 * @param channel - Twitch channel the message was sent in (also the send target for the win announcement).
 * @param rawMessage - Raw chat message text.
 * @param tags - tmi.js chat user state for the sender — needs both the stable login and display name.
 * @returns Resolves once the answer has been recorded and any announcement sent.
 */
export async function executeTriviaAnswerForTwitch(
  channel: string,
  rawMessage: string,
  tags: tmi.ChatUserstate,
): Promise<void> {
  const command = extractCommand(rawMessage);
  if (!command) return;
  const match = ANSWER_PATTERN.exec(command);
  if (!match) return;

  const login = tags.username;
  if (!login) return;
  const displayName = tags['display-name'] ?? login;

  const groupKey = await resolveTriviaGroupKey(channel);
  const won = submitAnswer(groupKey, login, displayName, match[1]);
  if (!won) return;

  const runtime = triviaRuntime.get();
  if (!runtime) return;
  try {
    await runtime.send(channel, `🎉 ${displayName} got it right!`);
    log.info(`[Twitch] Announced trivia winner ${displayName} in ${channel}.`);
  } catch (err) {
    log.error(`[Twitch] Failed to announce trivia winner in ${channel}:`, err);
  }
}
