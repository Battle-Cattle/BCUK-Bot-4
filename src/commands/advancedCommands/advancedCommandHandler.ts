// Advanced commands: per-streamer commands a viewer buys with loyalty points from chat, or the
// streamer fires free from their Stream Deck. A chat use runs the gates (role, live-only,
// cooldowns, per-stream caps), charges the escalating cost, records the use, then fires the
// effects; a use whose companion push can't be delivered or isn't acknowledged is refunded.
import { randomUUID } from 'node:crypto';
import {
  countAdvancedCommandUses,
  getAdvancedCommand,
  getAdvancedCommandForTwitchChannel,
  getLoyaltyPointsBalance,
  getLoyaltyPointsConfig,
  isExcludedFromLoyaltyPoints,
  recordAdvancedCommandUsage,
  adjustLoyaltyPointsBalance,
  spendLoyaltyPoints,
  type AdvancedCommandUsageWindow,
  type DbAdvancedCommand,
} from '../../db';
import { createLogger } from '../../shared/logger';
import { getChannelStreamStart, isChannelLive } from '../../twitch/monitor/twitchMonitor';
import { extractArgs } from '../commandUtils';
import {
  computeCommandCost,
  createAdvancedCommandCooldowns,
  createNoticeThrottle,
  hasRequiredRole,
  type ChatRoleInfo,
} from './advancedCommandGates';
import { runAdvancedCommandEffects, type AdvancedCommandUse } from './advancedCommandEffects';
import { refundAdvancedCommandUse, trackAdvancedCommandAck } from './advancedCommandRefunds';
import { advancedCommandRuntimeRegistry } from './advancedCommandRuntime';

const log = createLogger('AdvancedCommands');

/** Offline uses count towards caps and pricing over this rolling window. */
export const OFFLINE_USAGE_WINDOW_MS = 12 * 60 * 60 * 1000;
/** Minimum gap between "can't do that yet" notices to the same viewer for the same command. */
const NOTICE_WINDOW_MS = 10_000;

const cooldowns = createAdvancedCommandCooldowns();
const notices = createNoticeThrottle(NOTICE_WINDOW_MS);

/** A Twitch chat message that might be an advanced command. */
export interface AdvancedCommandChatMessage {
  /** Normalised channel login. */
  channel: string;
  /** Sender's Twitch login. */
  userLogin: string;
  /** Sender's display name. */
  userName: string;
  /** Raw message text. */
  message: string;
  /** The message's first word, lowercased (from the caller's single `extractCommand`). */
  command: string | null;
  roles: ChatRoleInfo;
}

/** The streamer a Stream Deck use is for. */
export interface StreamDeckStreamer {
  id: number;
  discordId: string;
  twitchName: string;
}

/** Result of a Stream Deck trigger. */
export type StreamDeckTriggerResult = 'ok' | 'command_not_found' | 'command_disabled';

/**
 * Sends a chat notice to a viewer, at most once per {@link NOTICE_WINDOW_MS} per command and viewer.
 * @param channel - The channel.
 * @param key - Throttle key (command id and viewer).
 * @param message - The notice.
 */
async function sendNotice(channel: string, key: string, message: string): Promise<void> {
  const runtime = advancedCommandRuntimeRegistry.get();
  if (!runtime || !notices.tryClaim(key)) return;
  await runtime.send(channel, message).catch((err: unknown) => log.error(`Failed to send notice in ${channel}:`, err));
}

/**
 * The window a chat use counts in for caps and pricing: the current live stream, or a rolling
 * offline window.
 * @param channel - The channel login.
 * @param now - The current time.
 * @returns The window, and the stream start to stamp the use with (null offline).
 */
function usageWindow(channel: string, now: Date): { window: AdvancedCommandUsageWindow; streamStartedAt: Date | null } {
  const streamStartedAt = getChannelStreamStart(channel);
  if (streamStartedAt) return { window: { streamStartedAt }, streamStartedAt };
  return { window: { offlineSince: new Date(now.getTime() - OFFLINE_USAGE_WINDOW_MS) }, streamStartedAt: null };
}

/**
 * Checks the per-stream caps and works out this use's cost.
 * @param command - The command.
 * @param login - The viewer's login.
 * @param window - The stream (or offline window) to count in.
 * @returns The cost, or a notice saying why the use is refused.
 */
async function capsAndCost(
  command: DbAdvancedCommand,
  login: string,
  window: AdvancedCommandUsageWindow,
): Promise<{ cost: number } | { notice: string }> {
  const needsCount = command.priceStep > 0 || command.maxUsesPerStream !== null;
  const uses = needsCount ? await countAdvancedCommandUses(command.id, window) : 0;
  if (command.maxUsesPerStream !== null && uses >= command.maxUsesPerStream) {
    return { notice: `${command.name} has been used the maximum ${command.maxUsesPerStream} times this stream.` };
  }
  if (command.maxUsesPerUserPerStream !== null
    && await countAdvancedCommandUses(command.id, window, login) >= command.maxUsesPerUserPerStream) {
    return { notice: `@${login} you've used ${command.name} as many times as you can this stream.` };
  }
  return { cost: computeCommandCost(command, uses) };
}

/**
 * Charges a viewer for a use. A free use always succeeds; a paid one needs Loyalty Points on for
 * the streamer, the viewer not excluded, and enough balance.
 * @param command - The command.
 * @param login - The viewer's login.
 * @param cost - The points to charge.
 * @returns The balance after paying (null for a free use), or a notice (null to stay silent).
 */
async function charge(
  command: DbAdvancedCommand,
  login: string,
  cost: number,
): Promise<{ balance: number | null } | { notice: string | null }> {
  if (cost === 0) return { balance: null };
  const config = await getLoyaltyPointsConfig(command.streamerId);
  if (!config?.enabled || await isExcludedFromLoyaltyPoints(command.streamerId, login)) return { notice: null };
  const balance = await spendLoyaltyPoints(command.streamerId, login, cost);
  if (balance !== null) return { balance };
  const current = await getLoyaltyPointsBalance(command.streamerId, login);
  return { notice: `@${login} ${command.name} costs ${cost} points — you have ${current}.` };
}

/**
 * Runs the free checks for a chat use: enabled, role and live-only (silently refused), then
 * cooldowns (refused with a notice).
 * @param command - The command, or null if it's gone.
 * @param msg - The chat message.
 * @returns Null to proceed, `false` to stay silent, or a notice.
 */
function checkChatGates(command: DbAdvancedCommand | null, msg: AdvancedCommandChatMessage): string | false | null {
  if (!command?.isEnabled || !hasRequiredRole(command.minRole, msg.roles)) return false;
  if (command.liveOnly && !isChannelLive(msg.channel)) return false;
  const remaining = cooldowns.remainingSeconds(command, msg.userLogin);
  return remaining > 0 ? `@${msg.userLogin} ${command.name} is on cooldown — try again in ${remaining}s.` : null;
}

/**
 * Records a use, fires its effects, and starts (or short-circuits) the companion acknowledgement.
 * If recording fails after points were spent, the points are credited back before rethrowing.
 * @param use - The use.
 * @param streamStartedAt - The live stream's start, or null offline.
 */
async function fireUse(use: AdvancedCommandUse, streamStartedAt: Date | null): Promise<void> {
  try {
    await recordAdvancedCommandUsage({
      eventId: use.eventId,
      commandId: use.command.id,
      streamerId: use.command.streamerId,
      commandName: use.command.name,
      source: use.source,
      twitchUsername: use.userLogin,
      pointsSpent: use.pointsSpent,
      streamStartedAt,
      status: use.command.companionEnabled ? 'pending' : 'no_ack_needed',
    });
  } catch (err) {
    if (use.pointsSpent > 0 && use.userLogin) {
      await adjustLoyaltyPointsBalance(use.command.streamerId, use.userLogin, use.pointsSpent);
    }
    throw err;
  }

  // Track the acknowledgement the moment the event is pushed, not after the chat reply below it
  // is sent — otherwise a fast failure acknowledgement could arrive before it's being waited for.
  const outcome = await runAdvancedCommandEffects(use, {
    onPushed: () => trackAdvancedCommandAck(use.eventId, use.channel),
  });
  if (outcome === 'no_companion') await refundAdvancedCommandUse(use.eventId, 'no_companion', { channel: use.channel });
  log.info(`Advanced command '${use.command.name}' (${use.command.id}) fired from ${use.source} in ${use.channel}`);
}

/**
 * Handles a Twitch chat message that may trigger one of the channel's advanced commands.
 * @param msg - The chat message.
 * @returns Resolves once the use is handled (or ignored).
 */
export async function executeAdvancedCommandForTwitch(msg: AdvancedCommandChatMessage): Promise<void> {
  if (!msg.command) return;
  const route = await getAdvancedCommandForTwitchChannel(msg.channel, msg.command);
  if (!route) return;
  const command = await getAdvancedCommand(route.streamerId, route.commandId);
  const noticeKey = `${route.commandId}:${msg.userLogin}`;

  const gate = checkChatGates(command, msg);
  if (gate !== null || !command) {
    if (gate) await sendNotice(msg.channel, noticeKey, gate);
    return;
  }

  const now = new Date();
  const { window, streamStartedAt } = usageWindow(msg.channel, now);
  const priced = await capsAndCost(command, msg.userLogin, window);
  if ('notice' in priced) return sendNotice(msg.channel, noticeKey, priced.notice);
  const paid = await charge(command, msg.userLogin, priced.cost);
  if ('notice' in paid) {
    if (paid.notice) await sendNotice(msg.channel, noticeKey, paid.notice);
    return;
  }

  cooldowns.claim(command, msg.userLogin);
  await fireUse({
    command,
    eventId: randomUUID(),
    channel: msg.channel,
    discordId: route.discordId,
    source: 'chat',
    userLogin: msg.userLogin,
    userName: msg.userName,
    args: extractArgs(msg.message),
    pointsSpent: priced.cost,
    balance: paid.balance,
    triggeredAt: now,
  }, streamStartedAt);
}

/**
 * Fires one of a streamer's commands from their Stream Deck: free, and skipping the cooldowns,
 * role, live-only and caps. The command must still be enabled.
 * @param streamer - The streamer the Stream Deck key belongs to.
 * @param commandId - The command to fire.
 * @returns `ok`, or why it didn't fire.
 */
export async function triggerAdvancedCommandFromStreamDeck(
  streamer: StreamDeckStreamer,
  commandId: number,
): Promise<StreamDeckTriggerResult> {
  const command = await getAdvancedCommand(streamer.id, commandId);
  if (!command) return 'command_not_found';
  if (!command.isEnabled) return 'command_disabled';
  const channel = streamer.twitchName.toLowerCase();
  await fireUse({
    command,
    eventId: randomUUID(),
    channel,
    discordId: streamer.discordId,
    source: 'streamdeck',
    userLogin: null,
    userName: streamer.twitchName,
    args: '',
    pointsSpent: 0,
    balance: null,
    triggeredAt: new Date(),
  }, getChannelStreamStart(channel));
  return 'ok';
}

/** Forgets every cooldown and notice throttle (tests). */
export function clearAdvancedCommandState(): void {
  cooldowns.clear();
  notices.clear();
}
