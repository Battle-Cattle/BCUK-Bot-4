import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mockLogger } from '../../test-utils/loggerMock';
import { ACCESS_LEVEL_MOCK } from '../../test-utils/accessLevelMock';

vi.mock('../../shared/logger', () => ({ createLogger: mockLogger }));

vi.mock('../../db', () => ({
  getAllTimerCommandsWithAssignments: vi.fn(),
  getAllUsers: vi.fn(),
  findUser: vi.fn(),
  isTimerSelfManageableBy: (ids: string[], id: string) => ids.length === 1 && ids[0] === id,
  AccessLevel: ACCESS_LEVEL_MOCK,
}));

vi.mock('../csrf', () => ({
  csrfProtection: (req: any, _res: any, next: any) => {
    req.csrfToken = () => 'test-csrf-token';
    next();
  },
}));

const { middlewareCallOrder } = vi.hoisted(() => ({ middlewareCallOrder: [] as string[] }));
vi.mock('../middleware', () => ({
  requireGuildContext: (_req: any, _res: any, next: any) => { middlewareCallOrder.push('requireGuildContext'); next(); },
}));

// This module composes timersMutations's and timerAssignments's routers too; stub them out so
// this file only exercises the GET route defined directly in timers.ts.
vi.mock('./timersMutations', async () => {
  const { Router } = await import('express');
  return { default: Router() };
});
vi.mock('./timerAssignments', async () => {
  const { Router } = await import('express');
  return { default: Router() };
});

import supertest from 'supertest';
import router from './timers';
import { findUser, getAllTimerCommandsWithAssignments, getAllUsers } from '../../db';
import { buildTestApp } from '../../test-utils/expressTestApp';

type SessionUser = { discordId: string; discordName: string; discordAvatar: string | null; accessLevel: 0 | 1 | 2 | 3; isOwner: boolean };
const USER: SessionUser = { discordId: '100000000000000001', discordName: 'TestUser', discordAvatar: null, accessLevel: 2, isOwner: false };

function buildApp(sessionUser: SessionUser = USER) {
  return buildTestApp({ router, bodyParser: 'urlencoded', sessionUser, mockRender: 'spread' });
}

const STREAMER: SessionUser = { discordId: '111', discordName: 'Alice', discordAvatar: null, accessLevel: 0, isOwner: false };

function timerAssignedTo(id: number, discordIds: string[]): any {
  return {
    id, name: `Timer ${id}`, message: 'Hi', interval_seconds: 600, min_messages: 0, require_live: true, enabled: true,
    assigned_users: discordIds.map((discordId) => ({ discord_id: discordId, discord_name: null, twitch_name: 'x', access_level: 0, is_orphaned_user: false })),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  middlewareCallOrder.length = 0;
  vi.mocked(getAllTimerCommandsWithAssignments).mockResolvedValue([]);
  vi.mocked(getAllUsers).mockResolvedValue([]);
});

describe('GET /timers', () => {
  it('runs requireGuildContext (not an access-level gate), so the handler sees a fresh access level and can allow streamer self-service', async () => {
    await supertest(buildApp()).get('/timers');
    expect(middlewareCallOrder).toEqual(['requireGuildContext']);
  });

  it('shows a streamer only the timers on their own channel, with no user list, and marks which they can edit', async () => {
    vi.mocked(getAllTimerCommandsWithAssignments).mockResolvedValue([
      timerAssignedTo(1, ['111']),
      timerAssignedTo(2, ['111', '222']),
      timerAssignedTo(3, ['222']),
    ]);
    vi.mocked(findUser).mockResolvedValue({ discord_id: '111', twitch_name: 'alice' } as any);

    const res = await supertest(buildApp(STREAMER)).get('/timers');

    expect(getAllUsers).not.toHaveBeenCalled();
    expect(res.body.canManageCatalog).toBe(false);
    expect(res.body.twitchLinked).toBe(true);
    expect(res.body.assignableUsers).toEqual([]);
    expect(res.body.timers.map((timer: any) => [timer.id, timer.canEdit])).toEqual([[1, true], [2, false]]);
  });

  it('tells the view a streamer has no linked Twitch account', async () => {
    vi.mocked(findUser).mockResolvedValue({ discord_id: '111', twitch_name: null } as any);
    const res = await supertest(buildApp(STREAMER)).get('/timers');
    expect(res.body.twitchLinked).toBe(false);
  });

  it('gives a Mod the whole catalog with every timer editable', async () => {
    vi.mocked(getAllTimerCommandsWithAssignments).mockResolvedValue([timerAssignedTo(3, ['222'])]);
    const res = await supertest(buildApp({ ...STREAMER, accessLevel: 1 })).get('/timers');
    expect(res.body.canManageCatalog).toBe(true);
    expect(res.body.timers[0].canEdit).toBe(true);
  });

  it('renders the timers view with an empty list when there are no timers', async () => {
    const res = await supertest(buildApp()).get('/timers');
    expect(res.status).toBe(200);
    expect(res.body.view).toBe('timers');
    expect(res.body.timers).toEqual([]);
  });

  it("renders every timer with its assigned users and each timer's unassigned_users", async () => {
    vi.mocked(getAllTimerCommandsWithAssignments).mockResolvedValue([
      {
        id: 1, name: 'Plug', message: 'Join!', interval_seconds: 600, min_messages: 0,
        require_live: true, enabled: true,
        assigned_users: [{ discord_id: '111', discord_name: 'Alice', twitch_name: 'alice', access_level: 0, is_orphaned_user: false }],
      } as any,
    ]);
    vi.mocked(getAllUsers).mockResolvedValue([
      { discord_id: '111', twitch_name: 'alice' } as any,
      { discord_id: '222', twitch_name: 'bob' } as any,
      { discord_id: '333', twitch_name: null } as any,
    ]);

    const res = await supertest(buildApp()).get('/timers');

    expect(res.body.timers).toHaveLength(1);
    // only discord_id '222' (twitch_name present, not already assigned) should be unassigned
    expect(res.body.timers[0].unassigned_users).toEqual([{ discord_id: '222', twitch_name: 'bob' }]);
    // assignableUsers excludes the null-twitch_name entry
    expect(res.body.assignableUsers).toHaveLength(2);
  });

  it('returns a 500 error page when loading timers fails', async () => {
    vi.mocked(getAllTimerCommandsWithAssignments).mockRejectedValue(new Error('db down'));
    const res = await supertest(buildApp()).get('/timers');
    expect(res.status).toBe(500);
  });

  it('passes a known error param to the view', async () => {
    const res = await supertest(buildApp()).get('/timers?error=add_failed');
    expect(res.body.error).toBe('add_failed');
  });

  it('passes null to the view for an unknown error param', async () => {
    const res = await supertest(buildApp()).get('/timers?error=totally_unknown');
    expect(res.body.error).toBeNull();
  });
});
