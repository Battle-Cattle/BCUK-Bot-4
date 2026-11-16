/**
 * Inbound Twitch chat: routes each chat message the bot receives to every command handler.
 * The chat client itself (connect/disconnect, outbound sends) lives in `twitchBot.ts`, which
 * registers {@link handleTwitchMessage} as its `onMessage` listener.
 */
import type { ChatMessage } from '@twurple/chat';
import { handleCommand } from '../commands/commandRouter';
import { executeCustomCommandForTwitch } from '../commands/customCommandHandler';
import { executeCounterCommandForTwitch } from '../commands/counterHandler';
import { executeMultiCommandForTwitch } from '../commands/multiCommandHandler';
import { executeShoutoutForTwitch } from '../commands/shoutoutHandler';
import { executeCountdownForTwitch } from '../commands/countdownHandler';
import { executeFollowageForTwitch } from '../commands/followageHandler';
import { awardPointsForChatMessage } from '../commands/pointsEarnHandler';
import { executePointsCommandForTwitch } from '../commands/pointsHandler';
import { executeGambleCommandForTwitch, GAMBLE_COMMAND } from '../commands/gambleHandler';
import { executeRaffleCommandForTwitch } from '../commands/raffle/raffleHandler';
import { executeAdvancedCommandForTwitch } from '../commands/advancedCommands/advancedCommandHandler';
import { fireAndForget, extractCommand } from '../commands/commandUtils';
import { recordChatMessage } from './twitchChatActivity';
import { normalizeTwitchChannelName } from './twitchChannelName';
import { createLogger } from '../shared/logger';
import { resolveGuildIdForDiscordId } from './twitchGuildResolutionRuntime';
import { resolveDiscordIdForTwitchChannel, resolveStreamerIdForDiscordId } from './twitchChannelResolution';
import { getActiveChannels } from './twitchChannelMembership';

const log = createLogger('Twitch');

/**
 * Dispatches the two handlers that need the target guild (counters and the shared SFX command
 * router), sharing one guild resolution between them. Both no-op on a message with no command
 * token (ordinary chat without a `!`/`#` prefix), so that case skips them and the guild
 * resolution entirely.
 * @param normalizedChannel - Normalized (lowercase, no `#`) Twitch channel name.
 * @param message - Raw chat message text.
 * @param displayName - Sender's display name, or null.
 * @param command - The message's parsed command token, or null if it isn't a command.
 * @param discordIdPromise - This message's single Twitch-channel → Discord ID resolution.
 */
function dispatchGuildScopedCommands(
  normalizedChannel: string,
  message: string,
  displayName: string | null,
  command: string | null,
  discordIdPromise: Promise<string | null>,
): void {
  if (command === null) return;
  const guildIdPromise = discordIdPromise.then(resolveGuildIdForDiscordId);
  fireAndForget(
    guildIdPromise.then((guildId) =>
      executeCounterCommandForTwitch(normalizedChannel, message, displayName, guildId, command)),
    'Counter command error',
    log,
  );
  fireAndForget(
    guildIdPromise.then((guildId) => handleCommand(message, 'twitch', guildId, command)),
    'Command handler error',
    log,
  );
}

/**
 * Dispatches chat-earn, `!points` and `!gamble`, which all need the channel's `streamer.id`.
 * @param normalizedChannel - Normalized (lowercase, no `#`) Twitch channel name.
 * @param user - Login name of the message's sender.
 * @param message - Raw chat message text.
 * @param command - The message's parsed command token, or null if it isn't a command.
 * @param streamerIdPromise - This message's single streamer-ID resolution, shared by all three.
 */
function dispatchPointsHandlers(
  normalizedChannel: string,
  user: string,
  message: string,
  command: string | null,
  streamerIdPromise: Promise<number | null>,
): void {
  const earnPromise = streamerIdPromise.then((streamerId) => {
    // Skip chat-earn for a !gamble message itself — spending points isn't chatting. !points
    // does earn (it's a chat message like any other), and chat-earn's cooldown is independent
    // of !gamble's, so no message here can put !gamble on cooldown either way.
    if (streamerId !== null && command !== GAMBLE_COMMAND) {
      return awardPointsForChatMessage(streamerId, user);
    }
  });
  fireAndForget(earnPromise, 'Points earn error', log);
  // !points waits for this message's own chat-earn award to settle (success or failure —
  // a failed award is already logged above and must not suppress the reply), so the balance
  // it reports already includes the points that message earned.
  fireAndForget(
    earnPromise
      .catch(() => undefined)
      .then(() => streamerIdPromise)
      .then((streamerId) => executePointsCommandForTwitch(normalizedChannel, streamerId, message, user, command)),
    'Points command error',
    log,
  );
  fireAndForget(
    streamerIdPromise.then((streamerId) =>
      executeGambleCommandForTwitch(normalizedChannel, streamerId, message, user, command)),
    'Gamble command error',
    log,
  );
}

/**
 * Twurple `onMessage` event handler: records the message for timer commands'
 * `min_messages` gate (see `twitchChatActivity.ts`), then dispatches it to
 * every command handler (custom commands, counters, `!multi`, `!so`, the shared
 * command router, countdowns) in parallel via {@link fireAndForget}. Ignores
 * messages from channels not in the active set, and messages shared into this
 * channel from a partner channel in a Twitch shared-chat session (so each
 * message is only recorded/handled once, in its source channel). Never fires
 * for the bot's own sent messages — Twitch doesn't echo them back over IRC —
 * so there's no self-message case to filter here (see `onOwnUserState` in `twitchChannelPrivilege.ts`
 * for how the bot's own privilege status is tracked instead).
 * @param channel - Twitch channel the message was received in (as `#channel`).
 * @param user - Login name of the message's sender.
 * @param message - Raw chat message text.
 * @param msg - Full Twurple chat message, including sender badges/mod status and shared-chat info.
 */
export function handleTwitchMessage(channel: string, user: string, message: string, msg: ChatMessage): void {
  try {
    const normalizedChannel = normalizeTwitchChannelName(channel);
    if (!normalizedChannel) return;

    if (!getActiveChannels().has(normalizedChannel)) return;

    // In Twitch shared chat, sourceChannelId differs from channelId when a message
    // originated in a partner channel and was shared into this one. Skip it entirely
    // (including SFX command handling) so each message is only processed once, in
    // its source channel.
    if (msg.sourceChannelId && msg.sourceChannelId !== msg.channelId) return;

    recordChatMessage(normalizedChannel);

    // Twurple's ChatUser.displayName already falls back to the login when the display-name tag is unset.
    const displayName = msg.userInfo.displayName;
    const isMod = msg.userInfo.isMod || msg.userInfo.isBroadcaster;
    // Parsed once and threaded into every handler below instead of each one re-parsing
    // the same message independently.
    const command = extractCommand(message);

    // The channel's Discord ID is resolved once per message and shared by everything that
    // needs it (guild-scoped commands and the streamer-ID lookup), rather than each consumer
    // repeating the lookup — on an unlinked channel that lookup is a live DB query.
    const discordIdPromise = resolveDiscordIdForTwitchChannel(normalizedChannel);

    fireAndForget(executeCustomCommandForTwitch(normalizedChannel, message, displayName, command), 'Custom command error', log);
    dispatchGuildScopedCommands(normalizedChannel, message, displayName, command, discordIdPromise);
    fireAndForget(executeMultiCommandForTwitch(normalizedChannel, message, displayName, command), 'Multi command error', log);
    fireAndForget(executeShoutoutForTwitch(normalizedChannel, message, displayName, isMod, command), 'Shoutout error', log);
    fireAndForget(executeCountdownForTwitch(normalizedChannel, message, command), 'Countdown error', log);
    fireAndForget(
      executeAdvancedCommandForTwitch({
        channel: normalizedChannel,
        userLogin: user.toLowerCase(),
        userName: displayName,
        message,
        command,
        roles: {
          isBroadcaster: msg.userInfo.isBroadcaster,
          isMod: msg.userInfo.isMod,
          isVip: msg.userInfo.isVip,
          isSubscriber: msg.userInfo.isSubscriber || msg.userInfo.isFounder,
        },
      }),
      'Advanced command error',
      log,
    );
    fireAndForget(
      executeFollowageForTwitch(normalizedChannel, message, msg.channelId, { id: msg.userInfo.userId, name: displayName }, command),
      'Followage error',
      log,
    );
    // Chat-earn needs the streamer ID on every message (not just commands); it comes from a
    // cache, so this is no per-message DB query.
    const streamerIdPromise = discordIdPromise.then(resolveStreamerIdForDiscordId);
    dispatchPointsHandlers(normalizedChannel, user, message, command, streamerIdPromise);
    fireAndForget(
      streamerIdPromise.then((streamerId) =>
        executeRaffleCommandForTwitch({
          channel: normalizedChannel, streamerId, message, userLogin: user, command, isBroadcaster: msg.userInfo.isBroadcaster,
        })),
      'Raffle command error',
      log,
    );
  } catch (err) {
    log.error('Unexpected error in message handler:', err);
  }
}
