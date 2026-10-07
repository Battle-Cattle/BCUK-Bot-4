import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../twitch/twitchApi', () => ({ getCustomRewards: vi.fn() }));
vi.mock('../../twitch/eventsub/twitchApiEventSub', () => ({ getValidToken: vi.fn() }));

import { getCustomRewards } from '../../twitch/twitchApi';
import { getValidToken } from '../../twitch/eventsub/twitchApiEventSub';
import { fetchStreamerRewards } from './streamerRewards';

const log = { warn: vi.fn() } as any;
const streamer = { id: 1, twitch_user_id: 'tuid-1' } as any;

beforeEach(() => {
  vi.clearAllMocks();
});

describe('fetchStreamerRewards', () => {
  it('returns no rewards without a token lookup when the streamer has no twitch_user_id', async () => {
    expect(await fetchStreamerRewards({ ...streamer, twitch_user_id: null }, log)).toEqual([]);
    expect(getValidToken).not.toHaveBeenCalled();
  });

  it('returns no rewards when there is no valid token', async () => {
    vi.mocked(getValidToken).mockResolvedValue(null);
    expect(await fetchStreamerRewards(streamer, log)).toEqual([]);
    expect(getCustomRewards).not.toHaveBeenCalled();
  });

  it('returns the streamer\'s rewards when a token is available', async () => {
    vi.mocked(getValidToken).mockResolvedValue('tok');
    vi.mocked(getCustomRewards).mockResolvedValue([{ id: 'r1' }] as any);
    expect(await fetchStreamerRewards(streamer, log)).toEqual([{ id: 'r1' }]);
    expect(getCustomRewards).toHaveBeenCalledWith('tuid-1', 'tok');
  });

  it('logs and returns no rewards when the token refresh throws', async () => {
    vi.mocked(getValidToken).mockRejectedValue(new Error('db down'));
    expect(await fetchStreamerRewards(streamer, log)).toEqual([]);
    expect(log.warn).toHaveBeenCalledWith('Failed to fetch Twitch custom rewards:', expect.any(Error));
  });

  it('logs and returns no rewards when the Helix call throws', async () => {
    vi.mocked(getValidToken).mockResolvedValue('tok');
    vi.mocked(getCustomRewards).mockRejectedValue(new Error('500'));
    expect(await fetchStreamerRewards(streamer, log)).toEqual([]);
    expect(log.warn).toHaveBeenCalled();
  });
});
