// Advanced commands: per-streamer commands a viewer buys with loyalty points from chat, or the
// streamer fires free (and silently in chat) from their Stream Deck. A chat use runs the gates (role, live-only,
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
  type AdvancedCommandChatRoute,
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
  describeActiveCooldowns,
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
 * @param message - The notice, or a function building it (only called when the notice will be sent).
 */
async function sendNotice(channel: string, key: string, message: string | (() => Promise<string>)): Promise<void> {
  const runtime = advancedCommandRuntimeRegistry.get();
  if (!runtime || !notices.tryClaim(key)) return;
  try {
    await runtime.send(channel, typeof message === 'string' ? message : await message());
  } catch (err) {
    log.error(`Failed to send notice in ${channel}:`, err);
  }
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
 * Checks the per-stream caps and works out this use's cost. The broadcaster never pays.
 * @param command - The command.
 * @param msg - The chat message (the viewer's login and badges).
 * @param window - The stream (or offline window) to count in.
 * @returns The cost, or a notice saying why the use is refused.
 */
async function capsAndCost(
  command: DbAdvancedCommand,
  msg: Pick<AdvancedCommandChatMessage, 'userLogin' | 'roles'>,
  window: AdvancedCommandUsageWindow,
): Promise<{ cost: number } | { notice: string }> {
  const login = msg.userLogin;
  const needsCount = command.priceStep > 0 || command.maxUsesPerStream !== null;
  const uses = needsCount ? await countAdvancedCommandUses(command.id, window) : 0;
  if (command.maxUsesPerStream !== null && uses >= command.maxUsesPerStream) {
    return { notice: `${command.name} has been used the maximum ${command.maxUsesPerStream} times this stream.` };
  }
  if (command.maxUsesPerUserPerStream !== null
    && await countAdvancedCommandUses(command.id, window, login) >= command.maxUsesPerUserPerStream) {
    return { notice: `@${login} you've used ${command.name} as many times as you can this stream.` };
  }
  return { cost: msg.roles.isBroadcaster ? 0 : computeCommandCost(command, uses) };
}

/**
 * The "not enough points" part of a notice.
 * @param cost - The use's cost.
 * @param balance - The viewer's balance.
 * @returns E.g. `costs 100 points — you have 30`.
 */
function shortfallText(cost: number, balance: number): string {
  return `costs ${cost} points — you have ${balance}`;
}

/**
 * Whether the viewer pays in Loyalty Points here: it's on for the streamer and they aren't excluded.
 * @param command - The command.
 * @param login - The viewer's login.
 * @returns True if a paid use would be charged.
 */
async function paysWithPoints(command: DbAdvancedCommand, login: string): Promise<boolean> {
  const config = await getLoyaltyPointsConfig(command.streamerId);
  return !!config?.enabled && !await isExcludedFromLoyaltyPoints(command.streamerId, login);
}

/**
 * Builds the cooldown notice, adding the points shortfall when the viewer couldn't afford the
 * command anyway (only when Loyalty Points is on and the viewer isn't excluded).
 * @param command - The command.
 * @param active - The active cooldowns, from `describeActiveCooldowns`.
 * @param window - The stream (or offline window) to price the use in.
 * @param msg - The chat message (the viewer's login, and badges for the broadcaster's free use).
 * @returns The notice.
 */
async function cooldownNotice(
  command: DbAdvancedCommand,
  active: string,
  window: AdvancedCommandUsageWindow,
  msg: Pick<AdvancedCommandChatMessage, 'userLogin' | 'roles'>,
): Promise<string> {
  const login = msg.userLogin;
  const notice = `@${login} ${command.name} is on cooldown — ${active} left`;
  const priced = await capsAndCost(command, msg, window);
  if (!('cost' in priced) || priced.cost === 0 || !await paysWithPoints(command, login)) return `${notice}.`;
  const balance = await getLoyaltyPointsBalance(command.streamerId, login);
  return balance < priced.cost ? `${notice}, and it ${shortfallText(priced.cost, balance)}.` : `${notice}.`;
}

/**
 * Charges a viewer for a use. A free use (a free command, or the broadcaster) always succeeds and
 * reports the viewer's current balance for `{balance}`; a paid one needs Loyalty Points on for the
 * streamer, the viewer not excluded, and enough balance.
 * @param command - The command.
 * @param login - The viewer's login.
 * @param cost - The points to charge.
 * @returns The balance after paying (or the current one for a free use), or a notice (null to stay silent).
 */
async function charge(
  command: DbAdvancedCommand,
  login: string,
  cost: number,
): Promise<{ balance: number | null } | { notice: string | null }> {
  if (cost === 0) return { balance: await getLoyaltyPointsBalance(command.streamerId, login) };
  if (!await paysWithPoints(command, login)) return { notice: null };
  const balance = await spendLoyaltyPoints(command.streamerId, login, cost);
  if (balance !== null) return { balance };
  const current = await getLoyaltyPointsBalance(command.streamerId, login);
  return { notice: `@${login} ${command.name} ${shortfallText(cost, current)}.` };
}

/**
 * Runs the free checks for a chat use: enabled, role and live-only (silently refused), then
 * cooldowns (refused with a notice listing every active cooldown).
 * @param command - The command, or null if it's gone.
 * @param msg - The chat message.
 * @returns Null to proceed, `false` to stay silent, or the active cooldowns to report.
 */
function checkChatGates(command: DbAdvancedCommand | null, msg: AdvancedCommandChatMessage): string | false | null {
  if (!command?.isEnabled || !hasRequiredRole(command.minRole, msg.roles)) return false;
  if (command.liveOnly && !isChannelLive(msg.channel)) return false;
  return describeActiveCooldowns(cooldowns.remaining(command, msg.userLogin));
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
  if (outcome === 'no_companion') {
    try {
      await refundAdvancedCommandUse(use.eventId, 'no_companion', { channel: use.channel });
    } catch (err) {
      // The use is still pending; arm the timeout so the refund is retried (as `no_ack`).
      log.error(`Failed to refund advanced command ${use.eventId} (no companion); retrying after the ack timeout:`, err);
      trackAdvancedCommandAck(use.eventId, use.channel);
    }
  }
  log.info(`Advanced command '${use.command.name}' (${use.command.id}) fired from ${use.source} in ${use.channel}`);
}

/**
 * Looks up the channel's advanced command a chat message names.
 * @param msg - The chat message.
 * @returns The route and the command (null if it's gone), or null when the message isn't one.
 */
async function resolveChatCommand(
  msg: AdvancedCommandChatMessage,
): Promise<{ route: AdvancedCommandChatRoute; command: DbAdvancedCommand | null } | null> {
  if (!msg.command) return null;
  const route = await getAdvancedCommandForTwitchChannel(msg.channel, msg.command);
  return route ? { route, command: await getAdvancedCommand(route.streamerId, route.commandId) } : null;
}

/**
 * Checks the caps, prices the use and charges the viewer, sending the notice for any refusal.
 * @param command - The command.
 * @param msg - The chat message.
 * @param window - The stream (or offline window) to count and price in.
 * @param noticeKey - The notice throttle key.
 * @returns The cost and balance after paying, or null when the use is refused.
 */
async function priceAndCharge(
  command: DbAdvancedCommand,
  msg: AdvancedCommandChatMessage,
  window: AdvancedCommandUsageWindow,
  noticeKey: string,
): Promise<{ cost: number; balance: number | null } | null> {
  const priced = await capsAndCost(command, msg, window);
  if ('notice' in priced) {
    await sendNotice(msg.channel, noticeKey, priced.notice);
    return null;
  }
  const paid = await charge(command, msg.userLogin, priced.cost);
  if ('notice' in paid) {
    if (paid.notice) await sendNotice(msg.channel, noticeKey, paid.notice);
    return null;
  }
  return { cost: priced.cost, balance: paid.balance };
}

/**
 * Handles a Twitch chat message that may trigger one of the channel's advanced commands.
 * @param msg - The chat message.
 * @returns Resolves once the use is handled (or ignored).
 */
export async function executeAdvancedCommandForTwitch(msg: AdvancedCommandChatMessage): Promise<void> {
  const resolved = await resolveChatCommand(msg);
  if (!resolved?.command) return;
  const { route, command } = resolved;
  const noticeKey = `${route.commandId}:${msg.userLogin}`;
  const now = new Date();
  const { window, streamStartedAt } = usageWindow(msg.channel, now);

  const gate = checkChatGates(command, msg);
  if (gate !== null) {
    if (gate) await sendNotice(msg.channel, noticeKey, () => cooldownNotice(command, gate, window, msg));
    return;
  }
  const paid = await priceAndCharge(command, msg, window, noticeKey);
  if (!paid) return;

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
    pointsSpent: paid.cost,
    balance: paid.balance,
    triggeredAt: now,
  }, streamStartedAt);
}

/**
 * Fires one of a streamer's commands from their Stream Deck: free, and skipping the cooldowns,
 * role, live-only and caps. It neither starts a cooldown nor counts towards caps or pricing (only
 * chat uses do), and posts no chat reply. The command must still be enabled.
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
