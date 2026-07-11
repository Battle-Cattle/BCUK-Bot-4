import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../db', () => ({
  isKeyApprovedForGuild: vi.fn(),
}));

vi.mock('../../discord/voicePresence', () => ({
  getActiveGuildForUser: vi.fn(),
}));

import { isKeyApprovedForGuild } from '../../db';
import { getActiveGuildForUser } from '../../discord/voicePresence';
import {
  resolveGuildIdFromChannelId,
  ensureGuildApproved,
  resolveChannelGuildOrRespond,
  resolvePresenceGuildOrRespond,
} from './streamdeckGuildResolution';

const API_KEY_OWNER = 'user-1';

/** Fake Discord client whose channels.fetch resolves any channel to the given guildId, or rejects/returns null. */
function makeClient(channelGuildId: string | null | 'throw' = 'guild-123') {
  return {
    channels: {
      fetch: vi.fn(async (channelId: string) => {
        if (channelGuildId === 'throw') throw new Error('fetch failed');
        return channelGuildId ? { id: channelId, guildId: channelGuildId } : null;
      }),
    },
  } as any;
}

function makeReqRes() {
  const req = { apiKeyOwner: API_KEY_OWNER } as any;
  const res = { status: vi.fn().mockReturnThis(), json: vi.fn().mockReturnThis() } as any;
  return { req, res };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(isKeyApprovedForGuild).mockResolvedValue(true);
  vi.mocked(getActiveGuildForUser).mockReturnValue('guild-123');
});

describe('resolveGuildIdFromChannelId', () => {
  it('returns the guild ID when the channel resolves', async () => {
    const client = makeClient('guild-123');
    await expect(resolveGuildIdFromChannelId(client, 'ch1')).resolves.toBe('guild-123');
  });

  it('returns null when the channel does not exist', async () => {
    const client = makeClient(null);
    await expect(resolveGuildIdFromChannelId(client, 'ch1')).resolves.toBeNull();
  });

  it('returns null when fetch throws', async () => {
    const client = makeClient('throw');
    await expect(resolveGuildIdFromChannelId(client, 'ch1')).resolves.toBeNull();
  });
});

describe('ensureGuildApproved', () => {
  it('returns true and sends nothing when the key is approved', async () => {
    const { req, res } = makeReqRes();
    await expect(ensureGuildApproved(req, res, 'guild-123')).resolves.toBe(true);
    expect(res.status).not.toHaveBeenCalled();
  });

  it('returns false and sends 403 when the key is not approved', async () => {
    vi.mocked(isKeyApprovedForGuild).mockResolvedValue(false);
    const { req, res } = makeReqRes();
    await expect(ensureGuildApproved(req, res, 'guild-123')).resolves.toBe(false);
    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith({ ok: false, error: 'Key not approved for this guild' });
  });
});

describe('resolveChannelGuildOrRespond', () => {
  it('returns the guild ID when the channel resolves and the key is approved', async () => {
    const { req, res } = makeReqRes();
    const client = makeClient('guild-123');
    await expect(resolveChannelGuildOrRespond(req, res, client, 'ch1')).resolves.toBe('guild-123');
  });

  it('returns null and sends 400 when the channel is unknown', async () => {
    const { req, res } = makeReqRes();
    const client = makeClient(null);
    await expect(resolveChannelGuildOrRespond(req, res, client, 'ch1')).resolves.toBeNull();
    expect(res.status).toHaveBeenCalledWith(400);
  });

  it('returns null and sends 403 when the key is not approved for the resolved guild', async () => {
    vi.mocked(isKeyApprovedForGuild).mockResolvedValue(false);
    const { req, res } = makeReqRes();
    const client = makeClient('guild-123');
    await expect(resolveChannelGuildOrRespond(req, res, client, 'ch1')).resolves.toBeNull();
    expect(res.status).toHaveBeenCalledWith(403);
  });
});

describe('resolvePresenceGuildOrRespond', () => {
  it('returns the guild ID when the owner has an active voice presence and the key is approved', async () => {
    const { req, res } = makeReqRes();
    const client = makeClient();
    await expect(resolvePresenceGuildOrRespond(req, res, client)).resolves.toBe('guild-123');
  });

  it('returns null and sends 503 when the owner has no active voice presence', async () => {
    vi.mocked(getActiveGuildForUser).mockReturnValue(null);
    const { req, res } = makeReqRes();
    const client = makeClient();
    await expect(resolvePresenceGuildOrRespond(req, res, client)).resolves.toBeNull();
    expect(res.status).toHaveBeenCalledWith(503);
  });

  it('returns null and sends 403 when the key is not approved for the presence-resolved guild', async () => {
    vi.mocked(isKeyApprovedForGuild).mockResolvedValue(false);
    const { req, res } = makeReqRes();
    const client = makeClient();
    await expect(resolvePresenceGuildOrRespond(req, res, client)).resolves.toBeNull();
    expect(res.status).toHaveBeenCalledWith(403);
  });
});
