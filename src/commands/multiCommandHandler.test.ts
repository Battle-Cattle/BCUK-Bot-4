import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mockLogger } from '../test-utils/loggerMock';

vi.mock('../shared/logger', () => ({ createLogger: mockLogger }));
vi.mock('../shared/config', () => ({ GLOBAL_COOLDOWN_MS: 3_000 }));

vi.mock('../twitch/monitor/twitchMonitor', () => ({
  getMultiTwitchDataForChannel: vi.fn(),
}));

vi.mock('./customCommandHandler', () => ({
  resolveSharedChatSessionId: vi.fn().mockResolvedValue(null),
}));

import {
  executeMultiCommandForTwitch,
  registerMultiTwitchRuntime,
} from './multiCommandHandler';
import { getMultiTwitchDataForChannel } from '../twitch/monitor/twitchMonitor';

const mockRuntime = {
  send: vi.fn().mockResolvedValue(undefined),
  getActiveChannels: vi.fn(),
  getLoginUserIds: vi.fn(),
};

// Base time far in the future, advanced further each test so any cooldown claim left over
// from a previous test (same channel key) has already expired — matches the pattern in
// counterHandler.test.ts.
const COOLDOWN_MS = 3_000;
let mockNow = 1_000_000_000_000;

beforeEach(() => {
  mockNow += COOLDOWN_MS + 1_000;
  vi.clearAllMocks();
  vi.spyOn(Date, 'now').mockReturnValue(mockNow);
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

  it('does not broadcast when channel is not in an active group', async () => {
    vi.mocked(getMultiTwitchDataForChannel).mockReturnValue(null);

    await executeMultiCommandForTwitch('#chan', '!multi', 'user1');

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
    const { resolveSharedChatSessionId } = await import('./customCommandHandler.js');
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

  it('does not throw and sends nothing when no participant channel is active', async () => {
    vi.mocked(getMultiTwitchDataForChannel).mockReturnValue({
      url: 'multitwitch.tv/a/b',
      participants: ['#a', '#b'],
    } as any);

    // Neither the source channel nor its participants are active
    mockRuntime.getActiveChannels.mockReturnValue(new Set<string>());

    await expect(executeMultiCommandForTwitch('#a', '!multi', 'user1')).resolves.toBeUndefined();
    expect(mockRuntime.send).not.toHaveBeenCalled();
  });
});

describe('multi cooldown', () => {
  it('blocks a second !multi from the same source channel within the cooldown window', async () => {
    vi.mocked(getMultiTwitchDataForChannel).mockReturnValue({
      url: 'multitwitch.tv/a/b',
      participants: ['#a', '#b'],
    } as any);
    mockRuntime.getActiveChannels.mockReturnValue(new Set(['#a', '#b']));

    await executeMultiCommandForTwitch('#a', '!multi', 'user1');
    expect(mockRuntime.send).toHaveBeenCalledTimes(2);

    await executeMultiCommandForTwitch('#a', '!multi', 'user1');
    expect(mockRuntime.send).toHaveBeenCalledTimes(2);
  });

  it('allows the same source channel to broadcast again once the cooldown has elapsed', async () => {
    vi.mocked(getMultiTwitchDataForChannel).mockReturnValue({
      url: 'multitwitch.tv/a/b',
      participants: ['#a', '#b'],
    } as any);
    mockRuntime.getActiveChannels.mockReturnValue(new Set(['#a', '#b']));

    await executeMultiCommandForTwitch('#a', '!multi', 'user1');
    expect(mockRuntime.send).toHaveBeenCalledTimes(2);

    // Still on cooldown.
    await executeMultiCommandForTwitch('#a', '!multi', 'user1');
    expect(mockRuntime.send).toHaveBeenCalledTimes(2);

    // Once the cooldown window has elapsed, the channel can claim again. Advance the shared
    // `mockNow` (not just a local offset) so later tests' beforeEach still clears this claim.
    mockNow += COOLDOWN_MS + 1;
    vi.spyOn(Date, 'now').mockReturnValue(mockNow);
    await executeMultiCommandForTwitch('#a', '!multi', 'user1');
    expect(mockRuntime.send).toHaveBeenCalledTimes(4);
  });

  it("does not apply one source channel's cooldown to another", async () => {
    vi.mocked(getMultiTwitchDataForChannel).mockReturnValue({
      url: 'multitwitch.tv/a/b',
      participants: ['#a', '#b'],
    } as any);
    mockRuntime.getActiveChannels.mockReturnValue(new Set(['#a', '#b']));

    await executeMultiCommandForTwitch('#a', '!multi', 'user1');
    expect(mockRuntime.send).toHaveBeenCalledTimes(2);

    await executeMultiCommandForTwitch('#b', '!multi', 'user1');
    expect(mockRuntime.send).toHaveBeenCalledTimes(4);
  });
});
