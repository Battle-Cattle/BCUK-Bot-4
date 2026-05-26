import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./logger', () => ({ createLogger: () => ({ info: vi.fn(), error: vi.fn() }) }));

vi.mock('./twitchMonitor', () => ({
  getMultiTwitchDataForChannel: vi.fn(),
}));

vi.mock('./commandMonitorStore', () => ({
  recordCommandTestEntry: vi.fn(),
}));

vi.mock('./customCommandHandler', () => ({
  resolveSharedChatSessionId: vi.fn().mockResolvedValue(null),
}));

import {
  executeMultiCommandForTwitch,
  registerMultiTwitchRuntime,
} from './multiCommandHandler';
import { getMultiTwitchDataForChannel } from './twitchMonitor';
import { recordCommandTestEntry } from './commandMonitorStore';

const mockRuntime = {
  send: vi.fn().mockResolvedValue(undefined),
  getActiveChannels: vi.fn(),
  getLoginUserIds: vi.fn(),
};

beforeEach(() => {
  vi.clearAllMocks();
  mockRuntime.send.mockResolvedValue(undefined);
  mockRuntime.getActiveChannels.mockReturnValue(new Set<string>());
  mockRuntime.getLoginUserIds.mockReturnValue(new Map<string, string>());
  registerMultiTwitchRuntime(mockRuntime);
});

describe('executeMultiCommandForTwitch', () => {
  it('does nothing for commands other than !multi', async () => {
    await executeMultiCommandForTwitch('#chan', '!other', 'user1');
    expect(vi.mocked(getMultiTwitchDataForChannel)).not.toHaveBeenCalled();
  });

  it('records the entry but does not broadcast when channel is not in an active group', async () => {
    vi.mocked(getMultiTwitchDataForChannel).mockReturnValue(null);

    await executeMultiCommandForTwitch('#chan', '!multi', 'user1');

    expect(vi.mocked(recordCommandTestEntry)).toHaveBeenCalledWith(
      expect.objectContaining({ response: '(not in an active multitwitch group)' }),
    );
    expect(mockRuntime.send).not.toHaveBeenCalled();
  });

  it('does nothing when no runtime is registered', async () => {
    vi.mocked(getMultiTwitchDataForChannel).mockReturnValue({
      url: 'multitwitch.tv/a/b',
      participants: ['#a', '#b'],
    } as any);

    registerMultiTwitchRuntime(null as any);
    await executeMultiCommandForTwitch('#a', '!multi', 'user1');

    expect(mockRuntime.send).not.toHaveBeenCalled();
  });

  it('broadcasts the multitwitch URL to all active participant channels', async () => {
    vi.mocked(getMultiTwitchDataForChannel).mockReturnValue({
      url: 'multitwitch.tv/a/b',
      participants: ['#a', '#b'],
    } as any);

    mockRuntime.getActiveChannels.mockReturnValue(new Set(['#a', '#b']));

    await executeMultiCommandForTwitch('#a', '!multi', 'user1');

    expect(mockRuntime.send).toHaveBeenCalledWith('#a', 'multitwitch.tv/a/b');
    expect(mockRuntime.send).toHaveBeenCalledWith('#b', 'multitwitch.tv/a/b');
    expect(mockRuntime.send).toHaveBeenCalledTimes(2);
  });

  it('only sends to channels that are currently active', async () => {
    vi.mocked(getMultiTwitchDataForChannel).mockReturnValue({
      url: 'multitwitch.tv/a/b/c',
      participants: ['#a', '#b', '#c'],
    } as any);

    // #c is not active (bot hasn't joined it)
    mockRuntime.getActiveChannels.mockReturnValue(new Set(['#a', '#b']));

    await executeMultiCommandForTwitch('#a', '!multi', null);

    expect(mockRuntime.send).toHaveBeenCalledTimes(2);
    expect(mockRuntime.send).not.toHaveBeenCalledWith('#c', expect.anything());
  });

  it('skips channels that share the same shared-chat session ID', async () => {
    const { resolveSharedChatSessionId } = await import('./customCommandHandler');
    vi.mocked(resolveSharedChatSessionId).mockResolvedValue('session-xyz');

    vi.mocked(getMultiTwitchDataForChannel).mockReturnValue({
      url: 'multitwitch.tv/a/b',
      participants: ['#a', '#b'],
    } as any);

    mockRuntime.getActiveChannels.mockReturnValue(new Set(['#a', '#b']));
    // Both channels map to the same user ID → same session → only one send
    mockRuntime.getLoginUserIds.mockReturnValue(new Map([['#a', 'u1'], ['#b', 'u1']]));

    await executeMultiCommandForTwitch('#a', '!multi', 'user1');

    expect(mockRuntime.send).toHaveBeenCalledTimes(1);
  });

  it('records the multitwitch URL in the command monitor entry', async () => {
    vi.mocked(getMultiTwitchDataForChannel).mockReturnValue({
      url: 'multitwitch.tv/a/b',
      participants: ['#a'],
    } as any);

    await executeMultiCommandForTwitch('#a', '!multi', 'user1');

    expect(vi.mocked(recordCommandTestEntry)).toHaveBeenCalledWith(
      expect.objectContaining({
        command: '!multi',
        response: 'multitwitch.tv/a/b',
        channel: '#a',
        user: 'user1',
      }),
    );
  });
});
