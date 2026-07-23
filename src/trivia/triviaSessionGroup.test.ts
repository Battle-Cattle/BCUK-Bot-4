import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mockLogger } from '../test-utils/loggerMock';

vi.mock('../shared/logger', () => ({ createLogger: mockLogger }));
vi.mock('../twitch/twitchApi', () => ({ getSharedChatSession: vi.fn() }));
vi.mock('../twitch/twitchChannelMembership', () => ({
  getActiveChannels: vi.fn(),
  getActiveChannelUserIds: vi.fn(),
}));
vi.mock('../commands/customCommandHandler', () => ({ resolveSharedChatSessionId: vi.fn() }));

import { resolveTriviaGroupKey, resolveTriviaGroup } from './triviaSessionGroup';
import { getSharedChatSession } from '../twitch/twitchApi';
import { getActiveChannels, getActiveChannelUserIds } from '../twitch/twitchChannelMembership';
import { resolveSharedChatSessionId } from '../commands/customCommandHandler';

beforeEach(() => {
  vi.clearAllMocks();
});

describe('resolveTriviaGroupKey', () => {
  it('returns the login itself when the channel has no known user ID', async () => {
    vi.mocked(getActiveChannelUserIds).mockReturnValue(new Map());
    const key = await resolveTriviaGroupKey('somechannel');
    expect(key).toBe('somechannel');
    expect(resolveSharedChatSessionId).not.toHaveBeenCalled();
  });

  it('returns the resolved shared-chat session ID when one exists', async () => {
    vi.mocked(getActiveChannelUserIds).mockReturnValue(new Map([['somechannel', 'uid-1']]));
    vi.mocked(resolveSharedChatSessionId).mockResolvedValue('session-42');
    const key = await resolveTriviaGroupKey('somechannel');
    expect(key).toBe('session-42');
    expect(resolveSharedChatSessionId).toHaveBeenCalledWith('uid-1');
  });

  it('falls back to the login when there is no active shared-chat session', async () => {
    vi.mocked(getActiveChannelUserIds).mockReturnValue(new Map([['somechannel', 'uid-1']]));
    vi.mocked(resolveSharedChatSessionId).mockResolvedValue(null);
    const key = await resolveTriviaGroupKey('somechannel');
    expect(key).toBe('somechannel');
  });

  it('falls back to the login when the session lookup rejects', async () => {
    vi.mocked(getActiveChannelUserIds).mockReturnValue(new Map([['somechannel', 'uid-1']]));
    vi.mocked(resolveSharedChatSessionId).mockRejectedValue(new Error('helix down'));
    const key = await resolveTriviaGroupKey('somechannel');
    expect(key).toBe('somechannel');
  });
});

describe('resolveTriviaGroup', () => {
  it('returns a solo group when the channel has no known user ID', async () => {
    vi.mocked(getActiveChannelUserIds).mockReturnValue(new Map());
    const group = await resolveTriviaGroup('somechannel');
    expect(group).toEqual({ groupKey: 'somechannel', members: ['somechannel'] });
    expect(getSharedChatSession).not.toHaveBeenCalled();
  });

  it('returns a solo group when there is no active shared-chat session', async () => {
    vi.mocked(getActiveChannelUserIds).mockReturnValue(new Map([['somechannel', 'uid-1']]));
    vi.mocked(getSharedChatSession).mockResolvedValue(null);
    const group = await resolveTriviaGroup('somechannel');
    expect(group).toEqual({ groupKey: 'somechannel', members: ['somechannel'] });
  });

  it('returns a solo group when the session lookup throws', async () => {
    vi.mocked(getActiveChannelUserIds).mockReturnValue(new Map([['somechannel', 'uid-1']]));
    vi.mocked(getSharedChatSession).mockRejectedValue(new Error('helix down'));
    const group = await resolveTriviaGroup('somechannel');
    expect(group).toEqual({ groupKey: 'somechannel', members: ['somechannel'] });
  });

  it('returns the session ID and every active participant when a shared-chat session exists', async () => {
    vi.mocked(getActiveChannelUserIds).mockReturnValue(new Map([['channela', 'uid-1']]));
    vi.mocked(getActiveChannels).mockReturnValue(new Set(['channela', 'channelb']));
    vi.mocked(getSharedChatSession).mockResolvedValue({
      session_id: 'session-42',
      host_broadcaster_id: 'uid-1',
      host_broadcaster_login: 'channela',
      host_broadcaster_name: 'ChannelA',
      participants: [
        { broadcaster_id: 'uid-1', broadcaster_login: 'ChannelA', broadcaster_name: 'ChannelA' },
        { broadcaster_id: 'uid-2', broadcaster_login: 'ChannelB', broadcaster_name: 'ChannelB' },
        // Not currently active (e.g. the bot isn't joined to it) — should be filtered out.
        { broadcaster_id: 'uid-3', broadcaster_login: 'ChannelC', broadcaster_name: 'ChannelC' },
      ],
      created_at: '',
      updated_at: '',
    });

    const group = await resolveTriviaGroup('channela');
    expect(group.groupKey).toBe('session-42');
    expect(group.members.sort()).toEqual(['channela', 'channelb']);
  });

  it('falls back to a solo group when none of the session participants are currently active', async () => {
    vi.mocked(getActiveChannelUserIds).mockReturnValue(new Map([['channela', 'uid-1']]));
    vi.mocked(getActiveChannels).mockReturnValue(new Set(['channela']));
    vi.mocked(getSharedChatSession).mockResolvedValue({
      session_id: 'session-42',
      host_broadcaster_id: 'uid-9',
      host_broadcaster_login: 'someoneelse',
      host_broadcaster_name: 'SomeoneElse',
      participants: [
        { broadcaster_id: 'uid-9', broadcaster_login: 'someoneelse', broadcaster_name: 'SomeoneElse' },
      ],
      created_at: '',
      updated_at: '',
    });

    const group = await resolveTriviaGroup('channela');
    expect(group).toEqual({ groupKey: 'session-42', members: ['channela'] });
  });
});
