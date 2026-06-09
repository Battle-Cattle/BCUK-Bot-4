import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../db', () => ({
  getAllUsers: vi.fn(),
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

import { getAllUsers, updateDiscordName } from '../../db';
import { getDiscordClient, fetchMemberDisplayName } from '../../discord/discordBot';
import express from 'express';
import supertest from 'supertest';

// Import module last so mocks are in place before module-level code runs
import router, { refreshState, type RefreshOutcome } from './adminRefresh';

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use(express.urlencoded({ extended: false }));
  app.use(router);
  return supertest(app);
}

function resetRefreshState() {
  refreshState.outcome = 'idle';
  refreshState.updatedCount = 0;
  refreshState.failureCount = 0;
  refreshState.startedAt = null;
  refreshState.finishedAt = null;
}

/** Wait for refreshState to leave 'running'. */
async function waitForRefreshComplete(timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (refreshState.outcome === 'running') {
    if (Date.now() > deadline) throw new Error('Timed out waiting for refresh to complete');
    await new Promise((r) => setTimeout(r, 10));
  }
}

beforeEach(() => {
  vi.clearAllMocks();
  resetRefreshState();
});

// ─── refreshState initial values ─────────────────────────────────────────────

describe('refreshState', () => {
  it('starts in idle state', () => {
    expect(refreshState.outcome).toBe('idle');
    expect(refreshState.updatedCount).toBe(0);
    expect(refreshState.failureCount).toBe(0);
    expect(refreshState.startedAt).toBeNull();
    expect(refreshState.finishedAt).toBeNull();
  });
});

// ─── GET /users/refresh-status ────────────────────────────────────────────────

describe('GET /users/refresh-status', () => {
  it('returns the current refreshState as JSON', async () => {
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

  it('reflects state changes', async () => {
    refreshState.outcome = 'success';
    refreshState.updatedCount = 3;
    const app = buildApp();
    const res = await app.get('/users/refresh-status');
    expect(res.body.outcome).toBe('success');
    expect(res.body.updatedCount).toBe(3);
  });
});

// ─── POST /users/refresh-names ────────────────────────────────────────────────

describe('POST /users/refresh-names', () => {
  it('redirects to /admin/users immediately', async () => {
    vi.mocked(getDiscordClient).mockReturnValue({} as any);
    vi.mocked(getAllUsers).mockResolvedValue([]);
    const app = buildApp();
    const res = await app.post('/users/refresh-names');
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/admin/users');
  });

  it('redirects without starting a second refresh when one is already running', async () => {
    refreshState.outcome = 'running';
    const app = buildApp();
    const res = await app.post('/users/refresh-names');
    expect(res.status).toBe(302);
    expect(getAllUsers).not.toHaveBeenCalled();
  });
});

// ─── runDiscordNameRefresh outcome logic ──────────────────────────────────────

describe('runDiscordNameRefresh outcomes', () => {
  it('outcome is "noop" when discord client ready but no users need updating', async () => {
    vi.mocked(getDiscordClient).mockReturnValue({} as any);
    vi.mocked(getAllUsers).mockResolvedValue([]);
    const app = buildApp();
    await app.post('/users/refresh-names');
    await waitForRefreshComplete();
    expect(refreshState.outcome).toBe('noop');
    expect(refreshState.updatedCount).toBe(0);
    expect(refreshState.failureCount).toBe(0);
    expect(refreshState.finishedAt).not.toBeNull();
  });

  it('outcome is "success" when all users are updated with no failures', async () => {
    vi.mocked(getDiscordClient).mockReturnValue({} as any);
    vi.mocked(getAllUsers).mockResolvedValue([
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
    expect(refreshState.outcome).toBe('success');
    expect(refreshState.updatedCount).toBe(2);
    expect(refreshState.failureCount).toBe(0);
  });

  it('outcome is "noop" when display names have not changed', async () => {
    vi.mocked(getDiscordClient).mockReturnValue({} as any);
    vi.mocked(getAllUsers).mockResolvedValue([
      { discord_id: '1', discord_name: 'UnchangedName' },
    ] as any);
    vi.mocked(fetchMemberDisplayName).mockResolvedValue('UnchangedName');

    const app = buildApp();
    await app.post('/users/refresh-names');
    await waitForRefreshComplete();
    expect(refreshState.outcome).toBe('noop');
    expect(refreshState.updatedCount).toBe(0);
    expect(updateDiscordName).not.toHaveBeenCalled();
  });

  it('outcome is "partial" when some users succeed and some fail', async () => {
    vi.mocked(getDiscordClient).mockReturnValue({} as any);
    vi.mocked(getAllUsers).mockResolvedValue([
      { discord_id: '1', discord_name: 'OldName1' },
      { discord_id: '2', discord_name: 'OldName2' },
    ] as any);
    vi.mocked(fetchMemberDisplayName)
      .mockResolvedValueOnce('NewName1')
      .mockResolvedValueOnce(null); // second lookup fails

    const app = buildApp();
    await app.post('/users/refresh-names');
    await waitForRefreshComplete();
    expect(refreshState.outcome).toBe('partial');
    expect(refreshState.updatedCount).toBe(1);
    expect(refreshState.failureCount).toBe(1);
  });

  it('outcome is "error" when all lookups fail', async () => {
    vi.mocked(getDiscordClient).mockReturnValue({} as any);
    vi.mocked(getAllUsers).mockResolvedValue([
      { discord_id: '1', discord_name: 'OldName1' },
    ] as any);
    vi.mocked(fetchMemberDisplayName).mockResolvedValue(null);

    const app = buildApp();
    await app.post('/users/refresh-names');
    await waitForRefreshComplete();
    expect(refreshState.outcome).toBe('error');
    expect(refreshState.updatedCount).toBe(0);
    expect(refreshState.failureCount).toBe(1);
  });

  it('outcome is "error" when Discord client is not ready', async () => {
    vi.mocked(getDiscordClient).mockReturnValue(null);

    const app = buildApp();
    await app.post('/users/refresh-names');
    await waitForRefreshComplete();
    expect(refreshState.outcome).toBe('error');
  });

  it('finishedAt is set after completion', async () => {
    vi.mocked(getDiscordClient).mockReturnValue({} as any);
    vi.mocked(getAllUsers).mockResolvedValue([]);

    const before = Date.now();
    const app = buildApp();
    await app.post('/users/refresh-names');
    await waitForRefreshComplete();
    expect(refreshState.finishedAt).toBeGreaterThanOrEqual(before);
  });

  it('individual user errors are caught and counted as failures', async () => {
    vi.mocked(getDiscordClient).mockReturnValue({} as any);
    vi.mocked(getAllUsers).mockResolvedValue([
      { discord_id: '1', discord_name: 'OldName' },
    ] as any);
    vi.mocked(fetchMemberDisplayName).mockRejectedValue(new Error('Network error'));

    const app = buildApp();
    await app.post('/users/refresh-names');
    await waitForRefreshComplete();
    expect(refreshState.failureCount).toBe(1);
    expect(refreshState.outcome).toBe('error');
  });
});
