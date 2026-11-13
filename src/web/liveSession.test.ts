import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./guildAccess', () => ({ getLiveAccessForRequest: vi.fn(), hasPanelAccess: vi.fn() }));

import { getLiveAccessForRequest, hasPanelAccess } from './guildAccess';
import { hasLiveSession, isLiveOwner } from './liveSession';

const access = { dbUser: { discord_id: 'u1', is_owner: false }, live: { guilds: [], accessLevelByGuildId: new Map() } } as any;

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getLiveAccessForRequest).mockResolvedValue(access);
});

describe('hasLiveSession', () => {
  it('is false without a session user, without a DB lookup', async () => {
    await expect(hasLiveSession({ session: {} } as any)).resolves.toBe(false);
    expect(getLiveAccessForRequest).not.toHaveBeenCalled();
  });

  it('is true, keeping the session, while the user has panel access', async () => {
    vi.mocked(hasPanelAccess).mockReturnValue(true);
    const destroy = vi.fn();
    await expect(hasLiveSession({ session: { user: { discordId: 'u1' }, destroy } } as any)).resolves.toBe(true);
    expect(destroy).not.toHaveBeenCalled();
  });

  it('destroys the session and is false once access has ended', async () => {
    vi.mocked(hasPanelAccess).mockReturnValue(false);
    const destroy = vi.fn((cb: () => void) => { cb(); });
    await expect(hasLiveSession({ session: { user: { discordId: 'u1' }, destroy } } as any)).resolves.toBe(false);
    expect(destroy).toHaveBeenCalledOnce();
  });
});

describe('isLiveOwner', () => {
  it('refreshes the cached owner flag from the live user row', async () => {
    vi.mocked(getLiveAccessForRequest).mockResolvedValue({ ...access, dbUser: { discord_id: 'u1', is_owner: true } });
    const req = { session: { user: { discordId: 'u1', isOwner: false } } } as any;
    await expect(isLiveOwner(req)).resolves.toBe(true);
    expect(req.session.user.isOwner).toBe(true);
  });

  it('is false when the user row is gone, or there is no session user', async () => {
    vi.mocked(getLiveAccessForRequest).mockResolvedValue(null);
    await expect(isLiveOwner({ session: { user: { discordId: 'u1', isOwner: true } } } as any)).resolves.toBe(false);
    await expect(isLiveOwner({ session: {} } as any)).resolves.toBe(false);
  });
});
