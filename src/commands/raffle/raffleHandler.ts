import { createLogger } from '../../shared/logger';
import {
  adjustLoyaltyPointsBalance,
  getLoyaltyPointsConfig,
  isExcludedFromLoyaltyPoints,
  MAX_LOYALTY_POINTS_BALANCE,
} from '../../db';
import { extractArgs } from '../commandUtils';
import { createRuntimeRegistry } from '../../shared/runtimeRegistry';
import type { TwitchSendRuntime } from '../twitchRuntime';
import { parsePointsAmount } from '../gambleAmount';
import { normalizeTwitchChannelName } from '../../twitch/twitchChannelName';
import { resolveSharedChatSessionId } from '../customCommandHandler';
import { getPrizeShare, pickWinners, rollWinnerCount } from './raffleWinners';
import {
  RAFFLE_DURATION_SECONDS,
  RAFFLE_USAGE_MESSAGE,
  buildRaffleAlreadyRunningMessage,
  buildRaffleReminderMessage,
  buildRaffleResultMessage,
  buildRaffleStartMessage,
} from './raffleMessages';

const log = createLogger('Raffle');

/** The `!raffle` command token: the broadcaster starts a raffle with it. */
const RAFFLE_COMMAND = '!raffle';
/** The `!join` command token: viewers enter the open raffle with it. */
const JOIN_COMMAND = '!join';

/** Seconds between reminders while a raffle is open. */
const REMINDER_INTERVAL_SECONDS = 15;

/** Chat runtime the raffle needs: sending, plus channel login → Twitch user ID for the shared-chat check. */
export interface RaffleRuntime extends TwitchSendRuntime {
  getLoginUserIds: () => ReadonlyMap<string, string>;
}

/** Outcome of {@link startRaffle}. */
export type StartRaffleResult = 'ok' | 'already_running' | 'points_disabled' | 'chat_unavailable';

/** One open raffle, keyed by channel in {@link activeRaffles}. */
interface ActiveRaffle {
  streamerId: number;
  amount: number;
  entrants: Set<string>;
  endsAt: number;
  timers: NodeJS.Timeout[];
}

// Open raffles by normalised channel login. In memory only: production runs a single bot
// process (see "Single instance only" in CLAUDE.md), and a restart simply drops an open raffle.
const activeRaffles = new Map<string, ActiveRaffle>();

// ─── Twitch runtime (registered from index.ts before startTwitchBot) ─────────

const raffleRuntime = createRuntimeRegistry<RaffleRuntime>();

/**
 * Stores the Twitch chat runtime used to post raffle messages. Call once from index.ts after the Twitch bot is ready.
 * @param runtime - Twitch runtime whose `send` posts chat messages and whose `getLoginUserIds` maps channels to user IDs.
 */
export function registerRaffleTwitchRuntime(runtime: RaffleRuntime): void {
  raffleRuntime.register(runtime);
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Sends `message` to `channel`, logging (rather than throwing) on failure.
 * @param channel - Twitch channel login to post in.
 * @param message - Chat message to send.
 */
async function sendRaffleMessage(channel: string, message: string): Promise<void> {
  try {
    await raffleRuntime.get()?.send(channel, message);
  } catch (err) {
    log.error(`[Twitch] Failed to send raffle message in ${channel}:`, err);
  }
}

/**
 * Whether `channel` is in a Twitch shared-chat session right now, so raffle messages know to warn
 * that `!join` only counts in the broadcaster's own chat. Uses the 30s-cached session lookup the
 * timers and multi-channel commands share; an unknown channel or failed lookup counts as not shared.
 * @param channel - Normalised channel login.
 * @returns True if the channel is in a shared-chat session.
 */
async function isSharedChatActive(channel: string): Promise<boolean> {
  const userId = raffleRuntime.get()?.getLoginUserIds().get(channel);
  if (!userId) return false;
  try {
    return (await resolveSharedChatSessionId(userId)) !== null;
  } catch {
    return false;
  }
}

/**
 * Seconds left before `raffle` closes, rounded up and never below 0.
 * @param raffle - The open raffle.
 * @returns Whole seconds remaining.
 */
function secondsLeft(raffle: ActiveRaffle): number {
  return Math.max(0, Math.ceil((raffle.endsAt - Date.now()) / 1000));
}

/**
 * Credits each winner their share. A failed credit is logged and doesn't stop the others being paid.
 * @param streamerId - The streamer's `streamer.id` the points belong to.
 * @param winners - Twitch logins of the winners.
 * @param share - Points each winner gets.
 */
async function payWinners(streamerId: number, winners: readonly string[], share: number): Promise<void> {
  await Promise.all(winners.map(async (winner) => {
    try {
      await adjustLoyaltyPointsBalance(streamerId, winner, share);
    } catch (err) {
      log.error(`Failed to pay raffle winner ${winner} (streamer ${streamerId}):`, err);
    }
  }));
}

/**
 * Closes the raffle open in `channel`: removes it first so a late `!join` is ignored, draws a
 * random number of winners (up to one per three entrants, at most five), credits each an equal
 * whole-point share (any remainder isn't given out) and announces the result. Never rejects,
 * since it runs from a timer.
 * @param channel - Normalised channel login the raffle is open in.
 */
async function drawRaffle(channel: string): Promise<void> {
  const raffle = activeRaffles.get(channel);
  if (!raffle) return;
  activeRaffles.delete(channel);
  try {
    const entrants = [...raffle.entrants];
    const winners = pickWinners(entrants, rollWinnerCount(entrants.length));
    const share = getPrizeShare(raffle.amount, winners.length);
    await payWinners(raffle.streamerId, winners, share);
    log.info(`Raffle in ${channel} drew ${winners.length} winner(s) from ${entrants.length} entr${entrants.length === 1 ? 'y' : 'ies'}.`);
    await sendRaffleMessage(channel, buildRaffleResultMessage(entrants.length, winners, share));
  } catch (err) {
    log.error(`Failed to draw raffle in ${channel}:`, err);
  }
}

/**
 * Posts one reminder for `raffle`, if it's still the one open in `channel`.
 * @param channel - Normalised channel login the raffle is open in.
 * @param raffle - The raffle the reminder was scheduled for.
 * @param left - Seconds until it closes.
 */
async function sendReminder(channel: string, raffle: ActiveRaffle, left: number): Promise<void> {
  if (activeRaffles.get(channel) !== raffle) return;
  const sharedChat = await isSharedChatActive(channel);
  await sendRaffleMessage(channel, buildRaffleReminderMessage(channel, raffle.amount, left, raffle.entrants.size, sharedChat));
}

/**
 * Schedules the reminders (every 15s) and the draw (at 60s) for a raffle that just opened.
 * @param channel - Normalised channel login the raffle is open in.
 * @param raffle - The raffle; its `timers` collects the handles so they can be cancelled.
 */
function scheduleRaffle(channel: string, raffle: ActiveRaffle): void {
  for (let at = REMINDER_INTERVAL_SECONDS; at < RAFFLE_DURATION_SECONDS; at += REMINDER_INTERVAL_SECONDS) {
    const left = RAFFLE_DURATION_SECONDS - at;
    raffle.timers.push(setTimeout(() => {
      void sendReminder(channel, raffle, left);
    }, at * 1000).unref());
  }
  raffle.timers.push(setTimeout(() => { void drawRaffle(channel); }, RAFFLE_DURATION_SECONDS * 1000).unref());
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Opens a raffle in the broadcaster's channel: posts the announcement, then a reminder every 15
 * seconds, and draws the winners after 60 seconds. The prize is new points, not taken from anyone.
 * Shared by `!raffle` in chat and the Stream Deck route.
 * @param channel - The broadcaster's Twitch channel login.
 * @param streamerId - The broadcaster's `streamer.id`.
 * @param amount - Total points to give away; at least 1.
 * @returns `ok` once the announcement is posted; `already_running` if a raffle is open in this
 *   channel; `points_disabled` if the streamer hasn't turned on loyalty points; `chat_unavailable`
 *   if the channel name is invalid or the announcement couldn't be posted (the raffle is then cancelled).
 */
export async function startRaffle(channel: string, streamerId: number, amount: number): Promise<StartRaffleResult> {
  const key = normalizeTwitchChannelName(channel);
  if (!key) return 'chat_unavailable';
  const config = await getLoyaltyPointsConfig(streamerId);
  if (!config?.enabled) return 'points_disabled';
  if (activeRaffles.has(key)) return 'already_running';

  const raffle: ActiveRaffle = {
    streamerId,
    amount,
    entrants: new Set(),
    endsAt: Date.now() + RAFFLE_DURATION_SECONDS * 1000,
    timers: [],
  };
  activeRaffles.set(key, raffle);
  try {
    const runtime = raffleRuntime.get();
    if (!runtime) throw new Error('Twitch runtime not registered');
    await runtime.send(key, buildRaffleStartMessage(key, amount, await isSharedChatActive(key)));
  } catch (err) {
    log.error(`[Twitch] Failed to announce raffle in ${key}:`, err);
    if (activeRaffles.get(key) === raffle) activeRaffles.delete(key);
    return 'chat_unavailable';
  }
  scheduleRaffle(key, raffle);
  log.info(`Raffle for ${amount} points opened in ${key}.`);
  return 'ok';
}

/**
 * Parses a raffle prize and checks its range (1 up to the largest balance the points column holds).
 * @param input - The raw amount, e.g. `100`, `1,000` or `1K`.
 * @returns The prize, or null if `input` isn't a valid amount.
 */
export function parseRaffleAmount(input: string): number | null {
  const amount = parsePointsAmount(input);
  if (amount === null || amount < 1 || amount > MAX_LOYALTY_POINTS_BALANCE) return null;
  return amount;
}

/**
 * Handles `!raffle <amount>` from the broadcaster. Anyone else is ignored silently.
 * @param channel - Twitch channel the message was sent in.
 * @param streamerId - The channel's `streamer.id`.
 * @param rawMessage - Raw chat message text.
 */
async function handleRaffleCommand(channel: string, streamerId: number, rawMessage: string): Promise<void> {
  const amount = parseRaffleAmount(extractArgs(rawMessage));
  if (amount === null) {
    await sendRaffleMessage(channel, RAFFLE_USAGE_MESSAGE);
    return;
  }
  const result = await startRaffle(channel, streamerId, amount);
  const open = activeRaffles.get(normalizeTwitchChannelName(channel) ?? '');
  if (result === 'already_running' && open) await sendRaffleMessage(channel, buildRaffleAlreadyRunningMessage(secondsLeft(open)));
}

/**
 * Enters `username` into the raffle open in `channel`, without replying (a busy chat would
 * otherwise fill with confirmations; the reminders show the entry count). The broadcaster and
 * accounts on the loyalty-points exclusion list (bots) can't enter.
 * @param channel - Twitch channel the message was sent in.
 * @param username - Twitch login of the viewer joining.
 */
async function handleJoinCommand(channel: string, username: string): Promise<void> {
  const key = normalizeTwitchChannelName(channel);
  const raffle = key ? activeRaffles.get(key) : undefined;
  const login = username.toLowerCase();
  if (!key || !raffle || login === key) return;
  if (await isExcludedFromLoyaltyPoints(raffle.streamerId, username)) return;
  // The raffle may have closed while the exclusion lookup ran.
  if (activeRaffles.get(key) !== raffle) return;
  raffle.entrants.add(login);
}

/** A Twitch chat message as {@link executeRaffleCommandForTwitch} needs it. */
export interface RaffleChatMessage {
  /** Twitch channel the message was sent in (also the send target). */
  channel: string;
  /** The channel's linked `streamer.id`, or null if it has none. */
  streamerId: number | null;
  /** Raw chat message text. */
  message: string;
  /** Twitch login of the sender. */
  userLogin: string;
  /** Already-parsed command token, or null if the message isn't a command. */
  command: string | null;
  /** Whether the sender is the channel's broadcaster. */
  isBroadcaster: boolean;
}

/**
 * Handles a Twitch chat message that may be `!raffle` or `!join`. Only the broadcaster can start
 * a raffle; anyone else's `!raffle` is ignored. `!join` enters the open raffle silently. Shared-chat
 * messages never get here (`twitchBot.ts` drops them), which is why the announcement and reminders
 * warn during a shared-chat session that entries must be in the broadcaster's own chat.
 * @param chat - The chat message; no-ops without a linked streamer.
 * @returns Resolves once the command has been handled.
 */
export async function executeRaffleCommandForTwitch(chat: RaffleChatMessage): Promise<void> {
  const { channel, streamerId, message, userLogin, command, isBroadcaster } = chat;
  if (command !== RAFFLE_COMMAND && command !== JOIN_COMMAND) return;
  if (!streamerId) return;
  if (command === JOIN_COMMAND) {
    await handleJoinCommand(channel, userLogin);
  } else if (isBroadcaster) {
    await handleRaffleCommand(channel, streamerId, message);
  }
}

/** Cancels every open raffle without drawing it. Called from `shutdown()`, and by tests to reset state. */
export function stopAllRaffles(): void {
  for (const raffle of activeRaffles.values()) raffle.timers.forEach(clearTimeout);
  activeRaffles.clear();
}
