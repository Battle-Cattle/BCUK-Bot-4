import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { waitFor } from '../test-utils/waitFor';
import { mockLogger } from '../test-utils/loggerMock';

// ─── Module mocks (must precede imports) ─────────────────────────────────────

vi.mock('../shared/logger', () => ({ createLogger: mockLogger }));

// Only `streamer` is an active channel; membership itself is tested in twitchChannelMembership.test.ts.
vi.mock('./twitchChannelMembership', () => ({
  getActiveChannels: vi.fn(() => new Set(['streamer'])),
}));

// The resolvers' own caching/fallback behaviour is tested in twitchChannelResolution.test.ts;
// here they're stubs, so tests can count how often each message resolves them.
vi.mock('./twitchChannelResolution', () => ({
  resolveDiscordIdForTwitchChannel: vi.fn(),
  resolveStreamerIdForDiscordId: vi.fn(),
}));

vi.mock('./twitchGuildResolutionRuntime', () => ({
  resolveGuildIdForDiscordId: vi.fn(),
}));

vi.mock('../commands/commandRouter', () => ({
  handleCommand: vi.fn(),
}));

vi.mock('../commands/customCommandHandler', () => ({
  executeCustomCommandForTwitch: vi.fn(),
}));

vi.mock('../commands/counterHandler', () => ({
  executeCounterCommandForTwitch: vi.fn(),
}));

vi.mock('../commands/multiCommandHandler', () => ({
  executeMultiCommandForTwitch: vi.fn(),
}));

vi.mock('../commands/shoutoutHandler', () => ({
  executeShoutoutForTwitch: vi.fn(),
}));

vi.mock('../commands/countdownHandler', () => ({
  executeCountdownForTwitch: vi.fn(),
}));

vi.mock('../commands/followageHandler', () => ({
  executeFollowageForTwitch: vi.fn(),
}));

vi.mock('../commands/pointsEarnHandler', () => ({
  awardPointsForChatMessage: vi.fn(),
}));

vi.mock('../commands/pointsHandler', () => ({
  executePointsCommandForTwitch: vi.fn(),
}));

vi.mock('../commands/gambleHandler', () => ({
  executeGambleCommandForTwitch: vi.fn(),
  GAMBLE_COMMAND: '!gamble',
}));

vi.mock('../commands/raffle/raffleHandler', () => ({
  executeRaffleCommandForTwitch: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../commands/advancedCommands/advancedCommandHandler', () => ({
  executeAdvancedCommandForTwitch: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('./twitchChatActivity', () => ({
  recordChatMessage: vi.fn(),
}));

// ─── Imports (after mocks) ────────────────────────────────────────────────────

import { handleTwitchMessage } from './twitchMessageDispatch';
import { resolveDiscordIdForTwitchChannel, resolveStreamerIdForDiscordId } from './twitchChannelResolution';
import { resolveGuildIdForDiscordId } from './twitchGuildResolutionRuntime';
import { executeCustomCommandForTwitch } from '../commands/customCommandHandler';
import { executeCounterCommandForTwitch } from '../commands/counterHandler';
import { executeMultiCommandForTwitch } from '../commands/multiCommandHandler';
import { executeShoutoutForTwitch } from '../commands/shoutoutHandler';
import { handleCommand } from '../commands/commandRouter';
import { executeCountdownForTwitch } from '../commands/countdownHandler';
import { executeFollowageForTwitch } from '../commands/followageHandler';
import { awardPointsForChatMessage } from '../commands/pointsEarnHandler';
import { executePointsCommandForTwitch } from '../commands/pointsHandler';
import { executeGambleCommandForTwitch } from '../commands/gambleHandler';
import { executeRaffleCommandForTwitch } from '../commands/raffle/raffleHandler';
import { executeAdvancedCommandForTwitch } from '../commands/advancedCommands/advancedCommandHandler';
import { recordChatMessage } from './twitchChatActivity';

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Builds a minimal fake Twurple `ChatMessage` with the given userInfo/shared-chat overrides. */
function makeChatMessage(user: string, overrides: {
  isMod?: boolean;
  isVip?: boolean;
  isBroadcaster?: boolean;
  isSubscriber?: boolean;
  isFounder?: boolean;
  displayName?: string;
  userId?: string;
  channelId?: string | null;
  sourceChannelId?: string | null;
} = {}): any {
  return {
    userInfo: {
      isMod: overrides.isMod ?? false,
      isVip: overrides.isVip ?? false,
      isBroadcaster: overrides.isBroadcaster ?? false,
      isSubscriber: overrides.isSubscriber ?? false,
      isFounder: overrides.isFounder ?? false,
      // Twurple's ChatUser.displayName falls back to the login when the display-name tag is unset.
      displayName: overrides.displayName ?? user,
      userId: overrides.userId ?? 'user-id',
    },
    channelId: overrides.channelId ?? null,
    sourceChannelId: overrides.sourceChannelId ?? null,
  };
}

/**
 * Delivers a chat message to {@link handleTwitchMessage} as Twurple's `onMessage` would — with
 * any leading `#` stripped from `channel`, since Twurple emits `onMessage` with the plain login.
 */
function sendMessage(
  channel: string,
  user: string,
  message: string,
  msgOverrides: Parameters<typeof makeChatMessage>[1] = {},
): void {
  handleTwitchMessage(channel.replace(/^#/, ''), user, message, makeChatMessage(user, msgOverrides));
}

// ─── Lifecycle ────────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

// ─── handleTwitchMessage ─────────────────────────────────────────────────────

describe('handleTwitchMessage', () => {
  beforeEach(() => {
    vi.mocked(resolveDiscordIdForTwitchChannel).mockResolvedValue('streamer-discord-id');
    // Mirrors the real runtime's contract: a null (unlinked) Discord ID resolves to no guild.
    vi.mocked(resolveGuildIdForDiscordId).mockImplementation((discordId) => (discordId ? 'guild-A' : null));
    vi.mocked(resolveStreamerIdForDiscordId).mockResolvedValue(42);
  });

  it('ignores messages for an invalid channel name', () => {
    sendMessage('!!bad', 'alice', 'hello');
    expect(executeCustomCommandForTwitch).not.toHaveBeenCalled();
    expect(recordChatMessage).not.toHaveBeenCalled();
  });

  it('ignores messages for channels not in activeChannels', () => {
    sendMessage('#otherchan', 'alice', 'hello');
    expect(executeCustomCommandForTwitch).not.toHaveBeenCalled();
    expect(recordChatMessage).not.toHaveBeenCalled();
  });

  it('ignores shared-chat messages that originated in a different channel', () => {
    sendMessage('#streamer', 'alice', 'hello', { channelId: '111', sourceChannelId: '999' });
    expect(executeCustomCommandForTwitch).not.toHaveBeenCalled();
    expect(recordChatMessage).not.toHaveBeenCalled();
  });

  it('processes messages when sourceChannelId matches channelId', () => {
    vi.mocked(executeCustomCommandForTwitch).mockResolvedValue(undefined);
    sendMessage('#streamer', 'alice', 'hello', { channelId: '111', sourceChannelId: '111' });
    // Plain chat has no command prefix, so its command token is null.
    expect(executeCustomCommandForTwitch).toHaveBeenCalledWith('streamer', 'hello', 'alice', null);
    expect(recordChatMessage).toHaveBeenCalledWith('streamer');
  });

  it('records chat activity for a normal message', () => {
    sendMessage('#streamer', 'alice', 'hello');
    expect(recordChatMessage).toHaveBeenCalledWith('streamer');
  });

  it('dispatches all ten executors for a normal message', async () => {
    vi.mocked(executeCustomCommandForTwitch).mockResolvedValue(undefined);
    vi.mocked(executeCounterCommandForTwitch).mockResolvedValue(undefined);
    vi.mocked(executeMultiCommandForTwitch).mockResolvedValue(undefined);
    vi.mocked(executeShoutoutForTwitch).mockResolvedValue(undefined);
    vi.mocked(handleCommand).mockResolvedValue(undefined);
    vi.mocked(executeCountdownForTwitch).mockResolvedValue(undefined);
    vi.mocked(executeFollowageForTwitch).mockResolvedValue(undefined);
    vi.mocked(awardPointsForChatMessage).mockResolvedValue(undefined);
    vi.mocked(executePointsCommandForTwitch).mockResolvedValue(undefined);
    vi.mocked(executeGambleCommandForTwitch).mockResolvedValue(undefined);

    sendMessage('#streamer', 'alice', '!cmd', { displayName: 'Alice', userId: 'alice-id', channelId: 'streamer-id' });

    expect(executeCustomCommandForTwitch).toHaveBeenCalledWith('streamer', '!cmd', 'Alice', '!cmd');
    expect(executeMultiCommandForTwitch).toHaveBeenCalledWith('streamer', '!cmd', 'Alice', '!cmd');
    expect(executeShoutoutForTwitch).toHaveBeenCalledWith('streamer', '!cmd', 'Alice', false, '!cmd');
    // Guild resolution (Twitch-channel → discord_id → active voice guild) runs asynchronously
    // before handleCommand and executeCounterCommandForTwitch are invoked.
    await waitFor(() => expect(handleCommand).toHaveBeenCalledOnce());
    expect(handleCommand).toHaveBeenCalledWith('!cmd', 'twitch', 'guild-A', '!cmd');
    await waitFor(() => expect(executeCounterCommandForTwitch).toHaveBeenCalledOnce());
    expect(executeCounterCommandForTwitch).toHaveBeenCalledWith('streamer', '!cmd', 'Alice', 'guild-A', '!cmd');
    expect(executeCountdownForTwitch).toHaveBeenCalledWith('streamer', '!cmd', '!cmd');
    expect(executeFollowageForTwitch).toHaveBeenCalledWith('streamer', '!cmd', 'streamer-id', { id: 'alice-id', name: 'Alice' }, '!cmd');
    // Streamer-id resolution (Twitch-channel → discord_id → streamer.id) runs asynchronously
    // before the points-earn award, same as guild resolution above.
    await waitFor(() => expect(awardPointsForChatMessage).toHaveBeenCalledOnce());
    expect(awardPointsForChatMessage).toHaveBeenCalledWith(42, 'alice');
    await waitFor(() => expect(executePointsCommandForTwitch).toHaveBeenCalledOnce());
    expect(executePointsCommandForTwitch).toHaveBeenCalledWith('streamer', 42, '!cmd', 'alice', '!cmd');
    await waitFor(() => expect(executeGambleCommandForTwitch).toHaveBeenCalledOnce());
    expect(executeGambleCommandForTwitch).toHaveBeenCalledWith('streamer', 42, '!cmd', 'alice', '!cmd');
  });

  it('dispatches advanced commands with the sender\'s login, display name and chat roles', () => {
    sendMessage('#streamer', 'Alice', '!hydrate now', { displayName: 'AliceD', isVip: true, isFounder: true });

    expect(executeAdvancedCommandForTwitch).toHaveBeenCalledWith({
      channel: 'streamer',
      userLogin: 'alice',
      userName: 'AliceD',
      message: '!hydrate now',
      command: '!hydrate',
      roles: { isBroadcaster: false, isMod: false, isVip: true, isSubscriber: true },
    });
  });

  it('dispatches !raffle/!join with the streamer id and whether the sender is the broadcaster', async () => {
    sendMessage('#streamer', 'streamer', '!raffle 1K', { isBroadcaster: true });

    await waitFor(() => expect(executeRaffleCommandForTwitch).toHaveBeenCalledExactlyOnceWith({
      channel: 'streamer', streamerId: 42, message: '!raffle 1K', userLogin: 'streamer', command: '!raffle', isBroadcaster: true,
    }));
  });

  it('dispatches !join from a viewer as a non-broadcaster', async () => {
    sendMessage('#streamer', 'alice', '!join');

    await waitFor(() => expect(executeRaffleCommandForTwitch).toHaveBeenCalledExactlyOnceWith({
      channel: 'streamer', streamerId: 42, message: '!join', userLogin: 'alice', command: '!join', isBroadcaster: false,
    }));
  });

  it('does not award points when the channel has no linked streamer', async () => {
    vi.mocked(resolveStreamerIdForDiscordId).mockResolvedValue(null);
    vi.mocked(executePointsCommandForTwitch).mockResolvedValue(undefined);
    vi.mocked(executeGambleCommandForTwitch).mockResolvedValue(undefined);

    sendMessage('#streamer', 'alice', 'hello');

    await waitFor(() => expect(resolveStreamerIdForDiscordId).toHaveBeenCalledWith('streamer-discord-id'));
    expect(awardPointsForChatMessage).not.toHaveBeenCalled();
    // executePointsCommandForTwitch/executeGambleCommandForTwitch are still called (same as
    // executeCounterCommandForTwitch's guildId), with a null streamerId — they no-op internally
    // rather than being skipped here.
    expect(executePointsCommandForTwitch).toHaveBeenCalledWith('streamer', null, 'hello', 'alice', null);
    expect(executeGambleCommandForTwitch).toHaveBeenCalledWith('streamer', null, 'hello', 'alice', null);
  });

  it('does not award passive chat-earn points for a !gamble message, since placing a bet isn\'t chatting', async () => {
    vi.mocked(executeGambleCommandForTwitch).mockResolvedValue(undefined);

    sendMessage('#streamer', 'alice', '!gamble 100');

    await waitFor(() => expect(executeGambleCommandForTwitch).toHaveBeenCalledOnce());
    expect(executeGambleCommandForTwitch).toHaveBeenCalledWith('streamer', 42, '!gamble 100', 'alice', '!gamble');
    expect(awardPointsForChatMessage).not.toHaveBeenCalled();
  });

  it('awards chat-earn points for a !points message before replying, so the reported balance includes them', async () => {
    let finishAward!: () => void;
    vi.mocked(awardPointsForChatMessage).mockImplementation(() => new Promise<void>((resolve) => { finishAward = resolve; }));
    vi.mocked(executePointsCommandForTwitch).mockResolvedValue(undefined);

    sendMessage('#streamer', 'alice', '!points');

    await waitFor(() => expect(awardPointsForChatMessage).toHaveBeenCalledWith(42, 'alice'));
    await vi.advanceTimersByTimeAsync(0);
    expect(executePointsCommandForTwitch).not.toHaveBeenCalled();

    finishAward();
    await waitFor(() => expect(executePointsCommandForTwitch).toHaveBeenCalledOnce());
    expect(executePointsCommandForTwitch).toHaveBeenCalledWith('streamer', 42, '!points', 'alice', '!points');
  });

  it('still replies to !points when the chat-earn award fails', async () => {
    vi.mocked(awardPointsForChatMessage).mockRejectedValue(new Error('db down'));
    vi.mocked(executePointsCommandForTwitch).mockResolvedValue(undefined);

    sendMessage('#streamer', 'alice', '!points');

    await waitFor(() => expect(executePointsCommandForTwitch).toHaveBeenCalledOnce());
    expect(executePointsCommandForTwitch).toHaveBeenCalledWith('streamer', 42, '!points', 'alice', '!points');
  });

  it('resolves the target guild via the linked streamer\'s active voice presence', async () => {
    vi.mocked(handleCommand).mockResolvedValue(undefined);

    sendMessage('#streamer', 'alice', '!cmd');

    await waitFor(() => expect(handleCommand).toHaveBeenCalledOnce());
    expect(resolveDiscordIdForTwitchChannel).toHaveBeenCalledWith('streamer');
    expect(resolveGuildIdForDiscordId).toHaveBeenCalledWith('streamer-discord-id');
  });

  it('passes a null guildId to handleCommand and the counter handler when the channel has no linked Discord user', async () => {
    vi.mocked(resolveDiscordIdForTwitchChannel).mockResolvedValue(null);
    vi.mocked(handleCommand).mockResolvedValue(undefined);
    vi.mocked(executeCounterCommandForTwitch).mockResolvedValue(undefined);

    sendMessage('#streamer', 'alice', '!cmd');

    await waitFor(() => expect(handleCommand).toHaveBeenCalledOnce());
    expect(handleCommand).toHaveBeenCalledWith('!cmd', 'twitch', null, '!cmd');
    await waitFor(() => expect(executeCounterCommandForTwitch).toHaveBeenCalledOnce());
    expect(executeCounterCommandForTwitch).toHaveBeenCalledWith('streamer', '!cmd', 'alice', null, '!cmd');
  });

  it('resolves the channel\'s Discord ID, guild and streamer ID once per message, shared by every handler', async () => {
    vi.mocked(handleCommand).mockResolvedValue(undefined);
    vi.mocked(executeCounterCommandForTwitch).mockResolvedValue(undefined);
    vi.mocked(executePointsCommandForTwitch).mockResolvedValue(undefined);
    vi.mocked(executeGambleCommandForTwitch).mockResolvedValue(undefined);

    sendMessage('#streamer', 'alice', '!cmd');

    await waitFor(() => expect(handleCommand).toHaveBeenCalledOnce());
    await waitFor(() => expect(executeCounterCommandForTwitch).toHaveBeenCalledOnce());
    await waitFor(() => expect(executePointsCommandForTwitch).toHaveBeenCalledOnce());
    await waitFor(() => expect(executeGambleCommandForTwitch).toHaveBeenCalledOnce());
    expect(resolveDiscordIdForTwitchChannel).toHaveBeenCalledOnce();
    expect(resolveGuildIdForDiscordId).toHaveBeenCalledOnce();
    expect(resolveStreamerIdForDiscordId).toHaveBeenCalledExactlyOnceWith('streamer-discord-id');
  });

  it('skips guild resolution and the guild-scoped handlers for a message with no command token, but still earns points', async () => {
    vi.mocked(executeGambleCommandForTwitch).mockResolvedValue(undefined);

    // Ordinary chat has no !/# prefix, so extractCommand gives it no command token.
    sendMessage('#streamer', 'alice', 'hello everyone');

    await waitFor(() => expect(awardPointsForChatMessage).toHaveBeenCalledWith(42, 'alice'));
    await waitFor(() => expect(executeGambleCommandForTwitch).toHaveBeenCalledOnce());
    expect(resolveDiscordIdForTwitchChannel).toHaveBeenCalledOnce();
    expect(resolveGuildIdForDiscordId).not.toHaveBeenCalled();
    expect(handleCommand).not.toHaveBeenCalled();
    expect(executeCounterCommandForTwitch).not.toHaveBeenCalled();
  });

  it('passes the normalized channel and message to executors', () => {
    vi.mocked(executeCustomCommandForTwitch).mockResolvedValue(undefined);
    sendMessage('#STREAMER', 'alice', '!clap', { displayName: 'Alice' });
    expect(executeCustomCommandForTwitch).toHaveBeenCalledWith('streamer', '!clap', 'Alice', '!clap');
  });

  it('uses the login username as the display name when Twurple reports no display-name tag', () => {
    vi.mocked(executeCustomCommandForTwitch).mockResolvedValue(undefined);
    sendMessage('#streamer', 'alice', '!hi');
    expect(executeCustomCommandForTwitch).toHaveBeenCalledWith('streamer', '!hi', 'alice', '!hi');
  });

  it('detects isMod=true from userInfo.isMod', () => {
    vi.mocked(executeShoutoutForTwitch).mockResolvedValue(undefined);
    sendMessage('#streamer', 'alice', '!so alice', { isMod: true });
    expect(executeShoutoutForTwitch).toHaveBeenCalledWith('streamer', '!so alice', 'alice', true, '!so');
  });

  it('detects isMod=true from userInfo.isBroadcaster', () => {
    vi.mocked(executeShoutoutForTwitch).mockResolvedValue(undefined);
    sendMessage('#streamer', 'alice', '!so alice', { isBroadcaster: true });
    expect(executeShoutoutForTwitch).toHaveBeenCalledWith('streamer', '!so alice', 'alice', true, '!so');
  });

  it('passes isMod=false when neither isMod nor isBroadcaster is set', () => {
    vi.mocked(executeShoutoutForTwitch).mockResolvedValue(undefined);
    sendMessage('#streamer', 'alice', '!so alice');
    expect(executeShoutoutForTwitch).toHaveBeenCalledWith('streamer', '!so alice', 'alice', false, '!so');
  });
});
