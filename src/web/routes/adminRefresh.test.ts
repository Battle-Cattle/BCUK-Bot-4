import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../db', () => ({
  getGuildMemberUsers: vi.fn(),
  updateDiscordName: vi.fn(),
}));
vi.mock('../../discord/discordBot', () => ({
  getDiscordClient: vi.fn(),
  fetchMemberDisplayName: vi.fn(),
}));
vi.mock('../middleware', () => ({
  requireManager: (_req: any, _res: any, next: any) => next(),
}));
vi.mock('../csrf', () => ({
  csrfProtection: (_req: any, _res: any, next: any) => next(),
}));
vi.mock('../../shared/logger', () => ({
  createLogger: () => ({ warn: vi.fn(), error: vi.fn(), info: vi.fn() }),
}));

import { getGuildMemberUsers, updateDiscordName } from '../../db';
import { getDiscordClient, fetchMemberDisplayName } from '../../discord/discordBot';
import express from 'express';
import supertest from 'supertest';

// Import module last so mocks are in place before module-level code runs
import router, { refreshStates, getRefreshState } from './adminRefresh';

const GUILD_ID = '900000000000000001';
const OTHER_GUILD_ID = '900000000000000002';

function buildApp(currentGuildId: string = GUILD_ID) {
  const app = express();
  app.use(express.json());
  app.use(express.urlencoded({ extended: false }));
  app.use((req: any, _res: any, next: any) => {
    req.session = { user: { discordId: 'u1', currentGuildId, accessLevel: 2 } };
    next();
  });
  app.use(router);
  return supertest(app);
}

/** Wait for a guild's refresh state to leave 'running'. */
async function waitForRefreshComplete(guildId: string = GUILD_ID, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (getRefreshState(guildId).outcome === 'running') {
    if (Date.now() > deadline) throw new Error('Timed out waiting for refresh to complete');
    await new Promise((r) => setTimeout(r, 10));
  }
}

beforeEach(() => {
  vi.clearAllMocks();
  refreshStates.clear();
});

// ─── getRefreshState defaults ────────────────────────────────────────────────

describe('getRefreshState', () => {
  it('returns idle defaults for a guild with no recorded refresh', () => {
    expect(getRefreshState(GUILD_ID)).toEqual({
      outcome: 'idle',
      updatedCount: 0,
      failureCount: 0,
      startedAt: null,
      finishedAt: null,
    });
  });
});

// ─── GET /users/refresh-status ────────────────────────────────────────────────

describe('GET /users/refresh-status', () => {
  it('returns the current guild refresh state as JSON', async () => {
    const app = buildApp();
    const res = await app.get('/users/refresh-status');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      outcome: 'idle',
      updatedCount: 0,
      failureCount: 0,
      startedAt: null,
      finishedAt: null,
    });
  });

  it('reflects state changes for the requesting guild only', async () => {
    refreshStates.set(GUILD_ID, { outcome: 'success', updatedCount: 3, failureCount: 0, startedAt: 1, finishedAt: 2 });
    refreshStates.set(OTHER_GUILD_ID, { outcome: 'error', updatedCount: 0, failureCount: 1, startedAt: 1, finishedAt: 2 });

    const res = await buildApp(GUILD_ID).get('/users/refresh-status');
    expect(res.body.outcome).toBe('success');
    expect(res.body.updatedCount).toBe(3);

    const otherRes = await buildApp(OTHER_GUILD_ID).get('/users/refresh-status');
    expect(otherRes.body.outcome).toBe('error');
  });
});

// ─── POST /users/refresh-names ────────────────────────────────────────────────

describe('POST /users/refresh-names', () => {
  it('redirects to /admin/users immediately', async () => {
    vi.mocked(getDiscordClient).mockReturnValue({} as any);
    vi.mocked(getGuildMemberUsers).mockResolvedValue([]);
    const app = buildApp();
    const res = await app.post('/users/refresh-names');
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/admin/users');
  });

  it('redirects without starting a second refresh when one is already running for that guild', async () => {
    refreshStates.set(GUILD_ID, { outcome: 'running', updatedCount: 0, failureCount: 0, startedAt: Date.now(), finishedAt: null });
    const app = buildApp();
    const res = await app.post('/users/refresh-names');
    expect(res.status).toBe(302);
    expect(getGuildMemberUsers).not.toHaveBeenCalled();
  });

  it('starting a refresh for one guild does not block a refresh for a different guild', async () => {
    refreshStates.set(GUILD_ID, { outcome: 'running', updatedCount: 0, failureCount: 0, startedAt: Date.now(), finishedAt: null });
    vi.mocked(getDiscordClient).mockReturnValue({} as any);
    vi.mocked(getGuildMemberUsers).mockResolvedValue([]);

    const res = await buildApp(OTHER_GUILD_ID).post('/users/refresh-names');
    expect(res.status).toBe(302);
    await waitForRefreshComplete(OTHER_GUILD_ID);
    expect(getGuildMemberUsers).toHaveBeenCalledWith(OTHER_GUILD_ID);
    expect(getRefreshState(GUILD_ID).outcome).toBe('running');
  });
});

// ─── runDiscordNameRefresh outcome logic ──────────────────────────────────────

describe('runDiscordNameRefresh outcomes', () => {
  it('outcome is "noop" when discord client ready but no users need updating', async () => {
    vi.mocked(getDiscordClient).mockReturnValue({} as any);
    vi.mocked(getGuildMemberUsers).mockResolvedValue([]);
    const app = buildApp();
    await app.post('/users/refresh-names');
    await waitForRefreshComplete();
    expect(getRefreshState(GUILD_ID).outcome).toBe('noop');
    expect(getRefreshState(GUILD_ID).updatedCount).toBe(0);
    expect(getRefreshState(GUILD_ID).failureCount).toBe(0);
    expect(getRefreshState(GUILD_ID).finishedAt).not.toBeNull();
  });

  it('outcome is "success" when all users are updated with no failures', async () => {
    vi.mocked(getDiscordClient).mockReturnValue({} as any);
    vi.mocked(getGuildMemberUsers).mockResolvedValue([
      { discord_id: '1', discord_name: 'OldName1' },
      { discord_id: '2', discord_name: 'OldName2' },
    ] as any);
    vi.mocked(fetchMemberDisplayName)
      .mockResolvedValueOnce('NewName1')
      .mockResolvedValueOnce('NewName2');
    vi.mocked(updateDiscordName).mockResolvedValue(undefined);

    const app = buildApp();
    await app.post('/users/refresh-names');
    await waitForRefreshComplete();
    expect(getRefreshState(GUILD_ID).outcome).toBe('success');
    expect(getRefreshState(GUILD_ID).updatedCount).toBe(2);
    expect(getRefreshState(GUILD_ID).failureCount).toBe(0);
    expect(vi.mocked(updateDiscordName)).toHaveBeenCalledWith('1', 'NewName1');
    expect(vi.mocked(updateDiscordName)).toHaveBeenCalledWith('2', 'NewName2');
    expect(vi.mocked(fetchMemberDisplayName)).toHaveBeenCalledWith('1', true, GUILD_ID);
    expect(vi.mocked(fetchMemberDisplayName)).toHaveBeenCalledWith('2', true, GUILD_ID);
  });

  it('outcome is "noop" when display names have not changed', async () => {
    vi.mocked(getDiscordClient).mockReturnValue({} as any);
    vi.mocked(getGuildMemberUsers).mockResolvedValue([
      { discord_id: '1', discord_name: 'UnchangedName' },
    ] as any);
    vi.mocked(fetchMemberDisplayName).mockResolvedValue('UnchangedName');

    const app = buildApp();
    await app.post('/users/refresh-names');
    await waitForRefreshComplete();
    expect(getRefreshState(GUILD_ID).outcome).toBe('noop');
    expect(getRefreshState(GUILD_ID).updatedCount).toBe(0);
    expect(updateDiscordName).not.toHaveBeenCalled();
    expect(vi.mocked(fetchMemberDisplayName)).toHaveBeenCalledWith('1', true, GUILD_ID);
  });

  it('outcome is "partial" when some users succeed and some fail', async () => {
    vi.mocked(getDiscordClient).mockReturnValue({} as any);
    vi.mocked(getGuildMemberUsers).mockResolvedValue([
      { discord_id: '1', discord_name: 'OldName1' },
      { discord_id: '2', discord_name: 'OldName2' },
    ] as any);
    vi.mocked(fetchMemberDisplayName)
      .mockResolvedValueOnce('NewName1')
      .mockResolvedValueOnce(null); // second lookup fails

    const app = buildApp();
    await app.post('/users/refresh-names');
    await waitForRefreshComplete();
    expect(getRefreshState(GUILD_ID).outcome).toBe('partial');
    expect(getRefreshState(GUILD_ID).updatedCount).toBe(1);
    expect(getRefreshState(GUILD_ID).failureCount).toBe(1);
    expect(vi.mocked(fetchMemberDisplayName)).toHaveBeenCalledWith('1', true, GUILD_ID);
    expect(vi.mocked(fetchMemberDisplayName)).toHaveBeenCalledWith('2', true, GUILD_ID);
  });

  it('outcome is "error" when all lookups fail', async () => {
    vi.mocked(getDiscordClient).mockReturnValue({} as any);
    vi.mocked(getGuildMemberUsers).mockResolvedValue([
      { discord_id: '1', discord_name: 'OldName1' },
    ] as any);
    vi.mocked(fetchMemberDisplayName).mockResolvedValue(null);

    const app = buildApp();
    await app.post('/users/refresh-names');
    await waitForRefreshComplete();
    expect(getRefreshState(GUILD_ID).outcome).toBe('error');
    expect(getRefreshState(GUILD_ID).updatedCount).toBe(0);
    expect(getRefreshState(GUILD_ID).failureCount).toBe(1);
    expect(vi.mocked(fetchMemberDisplayName)).toHaveBeenCalledWith('1', true, GUILD_ID);
  });

  it('outcome is "error" when Discord client is not ready', async () => {
    vi.mocked(getDiscordClient).mockReturnValue(null);

    const app = buildApp();
    await app.post('/users/refresh-names');
    await waitForRefreshComplete();
    expect(getRefreshState(GUILD_ID).outcome).toBe('error');
  });

  it('finishedAt is set after completion', async () => {
    vi.mocked(getDiscordClient).mockReturnValue({} as any);
    vi.mocked(getGuildMemberUsers).mockResolvedValue([]);

    const before = Date.now();
    const app = buildApp();
    await app.post('/users/refresh-names');
    await waitForRefreshComplete();
    expect(getRefreshState(GUILD_ID).finishedAt).toBeGreaterThanOrEqual(before);
  });

  it('individual user errors are caught and counted as failures', async () => {
    vi.mocked(getDiscordClient).mockReturnValue({} as any);
    vi.mocked(getGuildMemberUsers).mockResolvedValue([
      { discord_id: '1', discord_name: 'OldName' },
    ] as any);
    vi.mocked(fetchMemberDisplayName).mockRejectedValue(new Error('Network error'));

    const app = buildApp();
    await app.post('/users/refresh-names');
    await waitForRefreshComplete();
    expect(getRefreshState(GUILD_ID).failureCount).toBe(1);
    expect(getRefreshState(GUILD_ID).outcome).toBe('error');
    expect(vi.mocked(fetchMemberDisplayName)).toHaveBeenCalledWith('1', true, GUILD_ID);
  });
});
