import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../db', () => ({
  getApprovedGuildIdsForKey: vi.fn(),
  getStreamerByDiscordId: vi.fn(),
}));

import { getApprovedGuildIdsForKey, getStreamerByDiscordId } from '../../db';
import { resolveStreamerOrRespond } from './streamdeckStreamerResolution';

const mockRes = () => {
  const res: any = {};
  res.status = vi.fn(() => res);
  res.json = vi.fn(() => res);
  return res;
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getApprovedGuildIdsForKey).mockResolvedValue(['g1']);
});

describe('resolveStreamerOrRespond', () => {
  it('returns the key owner\'s streamer', async () => {
    vi.mocked(getStreamerByDiscordId).mockResolvedValue({ id: 3, discord_id: 'owner-1', twitch_name: 'Streamer' } as any);
    const res = mockRes();
    expect(await resolveStreamerOrRespond({ apiKeyOwner: 'owner-1' } as any, res)).toEqual({ id: 3, discord_id: 'owner-1', twitch_name: 'Streamer' });
    expect(getStreamerByDiscordId).toHaveBeenCalledWith('owner-1');
    expect(res.status).not.toHaveBeenCalled();
  });

  it('responds 403 when the key is not approved for any guild', async () => {
    vi.mocked(getApprovedGuildIdsForKey).mockResolvedValue([]);
    const res = mockRes();
    expect(await resolveStreamerOrRespond({ apiKeyOwner: 'owner-1' } as any, res)).toBeNull();
    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith({ ok: false, error: 'Key not approved for any guild' });
  });

  it('responds 403 not_a_streamer when the owner has no Twitch login', async () => {
    vi.mocked(getStreamerByDiscordId).mockResolvedValue(null);
    const res = mockRes();
    expect(await resolveStreamerOrRespond({ apiKeyOwner: 'owner-1' } as any, res)).toBeNull();
    expect(res.json).toHaveBeenCalledWith({ ok: false, error: 'not_a_streamer' });
  });
});
