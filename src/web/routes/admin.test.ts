import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ACCESS_LEVEL_MOCK } from '../../test-utils/accessLevelMock';

vi.mock('../../db', () => ({
  findUser: vi.fn(),
  getMemberAccessLevel: vi.fn(),
  getEffectiveAccessLevelForUser: vi.fn(),
  getGuildMemberUsers: vi.fn(),
  setMemberAccessLevel: vi.fn(),
  removeGuildMember: vi.fn(),
  ACCESS_LEVEL_LABELS: { 0: 'User', 1: 'Mod', 2: 'Manager', 3: 'Admin' },
  AccessLevel: ACCESS_LEVEL_MOCK,
}));

vi.mock('../../discord/guildRegistry', () => ({
  reloadGuildRegistry: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../csrf', () => ({
  csrfProtection: (req: any, _res: any, next: any) => {
    req.csrfToken = () => 'test-csrf-token';
    next();
  },
}));

vi.mock('../middleware', () => ({
  requireManager: (_req: any, _res: any, next: any) => next(),
  requireAdmin: (_req: any, _res: any, next: any) => next(),
}));

vi.mock('../../twitch/twitchChannelName', () => ({
  normalizeTwitchChannelName: vi.fn(),
}));

// Real implementation (not a passthrough stub), with `run` wrapped in a spy so the
// race-regression test below can assert call order against getMemberAccessLevel's own mock —
// proving structurally (via mock.invocationCallOrder) that the authorization check happens
// *inside* the queued operation rather than before it's enqueued, with no timing dependency.
const { mockQueueRun } = vi.hoisted(() => ({ mockQueueRun: vi.fn() }));

vi.mock('../../shared/mutationQueue', async () => {
  const actual = await vi.importActual<typeof import('../../shared/mutationQueue')>('../../shared/mutationQueue');
  return {
    createMutationQueue: <K = string>() => {
      const queue = actual.createMutationQueue<K>();
      mockQueueRun.mockImplementation(queue.run.bind(queue));
      return { ...queue, run: mockQueueRun };
    },
  };
});

vi.mock('./adminRefresh', async () => {
  const { Router } = await import('express');
  return {
    default: Router(),
    getRefreshState: vi.fn(() => ({ outcome: 'idle', updatedCount: 0, failureCount: 0, startedAt: null, finishedAt: null })),
  };
});

vi.mock('./adminUserMutations', () => {
  class DuplicateTwitchNameError extends Error {}
  return {
    DuplicateTwitchNameError,
    isDuplicateTwitchNameDbError: vi.fn().mockReturnValue(false),
    isLockWaitTimeoutDbError: vi.fn().mockReturnValue(false),
    addOrUpdateUserMutation: vi.fn().mockResolvedValue(undefined),
    toggleTwitchMutation: vi.fn().mockResolvedValue(undefined),
  };
});

const { mockLog } = vi.hoisted(() => ({
  mockLog: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

vi.mock('../../shared/logger', () => ({
  createLogger: () => mockLog,
}));

import supertest from 'supertest';
import router from './admin';
import { findUser, getMemberAccessLevel, getEffectiveAccessLevelForUser, getGuildMemberUsers, setMemberAccessLevel, removeGuildMember } from '../../db';
import { reloadGuildRegistry } from '../../discord/guildRegistry';
import { AccessLevel } from '../../db';
import { normalizeTwitchChannelName } from '../../twitch/twitchChannelName';
import {
  DuplicateTwitchNameError,
  isDuplicateTwitchNameDbError,
  isLockWaitTimeoutDbError,
  addOrUpdateUserMutation,
  toggleTwitchMutation,
} from './adminUserMutations';
import { buildTestApp } from '../../test-utils/expressTestApp';

type SessionUser = {
  discordId: string;
  discordName: string;
  discordAvatar: string | null;
  isOwner: boolean;
  accessLevel: 0 | 1 | 2 | 3;
  currentGuildId: string;
};

const GUILD_ID = '900000000000000001';
const ADMIN: SessionUser = { discordId: '100000000000000001', discordName: 'AdminUser', discordAvatar: null, isOwner: false, accessLevel: AccessLevel.ADMIN, currentGuildId: GUILD_ID };
const MANAGER: SessionUser = { discordId: '200000000000000001', discordName: 'ManagerUser', discordAvatar: null, isOwner: false, accessLevel: AccessLevel.MANAGER, currentGuildId: GUILD_ID };
const VALID_ID = '300000000000000001';

/** Builds a supertest-ready app: the admin router with a stubbed session and a render mock that flattens locals into the JSON body. */
function buildApp(sessionUser: SessionUser = ADMIN) {
  return buildTestApp({ router, bodyParser: 'urlencoded', sessionUser, mockRender: 'spread' });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getGuildMemberUsers).mockResolvedValue([]);
  // The actor's own authorization is re-read from the DB inside checkManagerEditAuth/
  // checkToggleTwitchAuth (not trusted from the session) — see admin.ts's TOCTOU fix. These
  // stand in for that DB state, keyed by which fixture session is acting, so existing tests using
  // ADMIN/MANAGER continue to behave like an actual Admin/Manager without each test wiring it up.
  vi.mocked(findUser).mockImplementation(async (id: string) => {
    if (id === ADMIN.discordId || id === MANAGER.discordId) return { discord_id: id, is_owner: false } as any;
    return null;
  });
  vi.mocked(getEffectiveAccessLevelForUser).mockImplementation(async (_guildId: string, user: { discord_id: string }) => {
    if (user.discord_id === ADMIN.discordId) return AccessLevel.ADMIN;
    if (user.discord_id === MANAGER.discordId) return AccessLevel.MANAGER;
    return AccessLevel.USER;
  });
  vi.mocked(getMemberAccessLevel).mockResolvedValue(null);
  vi.mocked(setMemberAccessLevel).mockResolvedValue(undefined);
  vi.mocked(removeGuildMember).mockResolvedValue(undefined);
  vi.mocked(reloadGuildRegistry).mockResolvedValue(undefined);
  vi.mocked(addOrUpdateUserMutation).mockResolvedValue(undefined);
  vi.mocked(toggleTwitchMutation).mockResolvedValue(undefined);
  vi.mocked(isLockWaitTimeoutDbError).mockReturnValue(false);
  vi.mocked(isDuplicateTwitchNameDbError).mockReturnValue(false);
  vi.mocked(normalizeTwitchChannelName).mockImplementation((name: string) =>
    /^[a-z0-9_]+$/i.test(name) ? name.toLowerCase() : null,
  );
});

// --- GET /users ---

describe('GET /users', () => {
  it('renders the admin view on success', async () => {
    const res = await supertest(buildApp()).get('/users');
    expect(res.status).toBe(200);
    expect(res.body.view).toBe('admin');
  });

  it('passes a known error query param to the template', async () => {
    const res = await supertest(buildApp()).get('/users?error=db_busy');
    expect(res.status).toBe(200);
    expect(res.body.error).toBe('db_busy');
  });

  it('passes null to the template for an unknown error query param', async () => {
    const res = await supertest(buildApp()).get('/users?error=made_up_error');
    expect(res.status).toBe(200);
    expect(res.body.error).toBeNull();
  });

  it('returns 500 when getGuildMemberUsers throws', async () => {
    vi.mocked(getGuildMemberUsers).mockRejectedValue(new Error('DB down'));
    const res = await supertest(buildApp()).get('/users');
    expect(res.status).toBe(500);
  });
});

// --- POST /users/add ---

describe('POST /users/add', () => {
  it('redirects to /admin/users when discord_id is missing', async () => {
    const res = await supertest(buildApp()).post('/users/add').type('form').send({ access_level: '0' });
    expect(res.headers.location).toBe('/admin/users');
  });

  it('redirects to /admin/users when access_level is missing', async () => {
    const res = await supertest(buildApp()).post('/users/add').type('form').send({ discord_id: VALID_ID });
    expect(res.headers.location).toBe('/admin/users');
  });

  it('redirects ?error=invalid_discord_id for an invalid ID', async () => {
    const res = await supertest(buildApp()).post('/users/add').type('form').send({ discord_id: '1234', access_level: '0' });
    expect(res.headers.location).toBe('/admin/users?error=invalid_discord_id');
  });

  it('redirects ?error=invalid_access_level for an out-of-range access_level', async () => {
    const res = await supertest(buildApp()).post('/users/add').type('form').send({ discord_id: VALID_ID, access_level: '99' });
    expect(res.headers.location).toBe('/admin/users?error=invalid_access_level');
  });

  it('redirects ?error=invalid_twitch_name when twitch name fails normalisation', async () => {
    vi.mocked(normalizeTwitchChannelName).mockReturnValue(null);
    const res = await supertest(buildApp()).post('/users/add').type('form').send({ discord_id: VALID_ID, access_level: '0', twitch_name: 'bad name!' });
    expect(res.headers.location).toBe('/admin/users?error=invalid_twitch_name');
  });

  it('skips twitch validation when clear_twitch_name=1 and calls mutation with shouldClearTwitchName', async () => {
    vi.mocked(normalizeTwitchChannelName).mockReturnValue(null);
    const res = await supertest(buildApp()).post('/users/add').type('form')
      .send({ discord_id: VALID_ID, access_level: '0', twitch_name: 'bad name!', clear_twitch_name: '1' });
    expect(res.headers.location).toBe('/admin/users');
    expect(vi.mocked(addOrUpdateUserMutation)).toHaveBeenCalledWith(expect.objectContaining({ shouldClearTwitchName: true }));
  });

  it('redirects ?error=self_edit_forbidden when editing self', async () => {
    const res = await supertest(buildApp(ADMIN)).post('/users/add').type('form')
      .send({ discord_id: ADMIN.discordId, access_level: '0' });
    expect(res.headers.location).toBe('/admin/users?error=self_edit_forbidden');
  });

  it('redirects ?error=duplicate_twitch_name on DuplicateTwitchNameError', async () => {
    vi.mocked(addOrUpdateUserMutation).mockRejectedValue(new DuplicateTwitchNameError('testchan'));
    const res = await supertest(buildApp()).post('/users/add').type('form').send({ discord_id: VALID_ID, access_level: '0' });
    expect(res.headers.location).toBe('/admin/users?error=duplicate_twitch_name');
  });

  it('redirects ?error=duplicate_twitch_name when isDuplicateTwitchNameDbError returns true', async () => {
    vi.mocked(addOrUpdateUserMutation).mockRejectedValue(new Error('DB dup'));
    vi.mocked(isDuplicateTwitchNameDbError).mockReturnValue(true);
    const res = await supertest(buildApp()).post('/users/add').type('form').send({ discord_id: VALID_ID, access_level: '0' });
    expect(res.headers.location).toBe('/admin/users?error=duplicate_twitch_name');
  });

  it('redirects ?error=db_busy on lock timeout', async () => {
    vi.mocked(addOrUpdateUserMutation).mockRejectedValue(new Error('lock'));
    vi.mocked(isLockWaitTimeoutDbError).mockReturnValue(true);
    const res = await supertest(buildApp()).post('/users/add').type('form').send({ discord_id: VALID_ID, access_level: '0' });
    expect(res.headers.location).toBe('/admin/users?error=db_busy');
  });

  it('redirects ?error=add_failed on unexpected DB error', async () => {
    vi.mocked(addOrUpdateUserMutation).mockRejectedValue(new Error('unexpected'));
    const res = await supertest(buildApp()).post('/users/add').type('form').send({ discord_id: VALID_ID, access_level: '0' });
    expect(res.headers.location).toBe('/admin/users?error=add_failed');
  });

  it('redirects to /admin/users on success and grants guild membership', async () => {
    const res = await supertest(buildApp()).post('/users/add').type('form')
      .send({ discord_id: VALID_ID, discord_name: 'TestUser', access_level: '0', twitch_name: 'streamer' });
    expect(res.headers.location).toBe('/admin/users');
    expect(vi.mocked(addOrUpdateUserMutation)).toHaveBeenCalledWith(
      expect.objectContaining({ discordId: VALID_ID, discordName: 'TestUser', level: 0, normalizedTwitchName: 'streamer' }),
    );
    expect(vi.mocked(setMemberAccessLevel)).toHaveBeenCalledWith(GUILD_ID, VALID_ID, 0);
    expect(vi.mocked(reloadGuildRegistry)).toHaveBeenCalled();
  });

  it('still redirects to /admin/users when the registry reload fails, but logs the error', async () => {
    vi.mocked(reloadGuildRegistry).mockRejectedValue(new Error('registry unavailable'));
    const res = await supertest(buildApp()).post('/users/add').type('form').send({ discord_id: VALID_ID, access_level: '0' });
    expect(res.headers.location).toBe('/admin/users');
    expect(mockLog.error).toHaveBeenCalledWith('Guild registry reload after membership change failed:', expect.any(Error));
  });
});

// --- POST /users/update ---

describe('POST /users/update', () => {
  it('redirects to /admin/users when discord_id is missing', async () => {
    const res = await supertest(buildApp()).post('/users/update').type('form').send({ access_level: '0' });
    expect(res.headers.location).toBe('/admin/users');
  });

  it('redirects ?error=invalid_discord_id for an invalid ID', async () => {
    const res = await supertest(buildApp()).post('/users/update').type('form').send({ discord_id: 'bad', access_level: '0' });
    expect(res.headers.location).toBe('/admin/users?error=invalid_discord_id');
  });

  it('redirects ?error=invalid_access_level for an out-of-range level', async () => {
    const res = await supertest(buildApp()).post('/users/update').type('form').send({ discord_id: VALID_ID, access_level: '5' });
    expect(res.headers.location).toBe('/admin/users?error=invalid_access_level');
  });

  it('redirects ?error=db_busy on lock timeout', async () => {
    vi.mocked(setMemberAccessLevel).mockRejectedValue(new Error('lock'));
    vi.mocked(isLockWaitTimeoutDbError).mockReturnValue(true);
    const res = await supertest(buildApp()).post('/users/update').type('form').send({ discord_id: VALID_ID, access_level: '0' });
    expect(res.headers.location).toBe('/admin/users?error=db_busy');
  });

  it('redirects ?error=update_failed on unexpected DB error', async () => {
    vi.mocked(setMemberAccessLevel).mockRejectedValue(new Error('unexpected'));
    const res = await supertest(buildApp()).post('/users/update').type('form').send({ discord_id: VALID_ID, access_level: '0' });
    expect(res.headers.location).toBe('/admin/users?error=update_failed');
  });

  it('redirects to /admin/users on success and writes the per-guild level', async () => {
    const res = await supertest(buildApp()).post('/users/update').type('form').send({ discord_id: VALID_ID, access_level: '1' });
    expect(res.headers.location).toBe('/admin/users');
    expect(vi.mocked(setMemberAccessLevel)).toHaveBeenCalledWith(GUILD_ID, VALID_ID, 1);
  });

  // Regression coverage for the TOCTOU authorization race: checkManagerEditAuth now runs
  // *inside* the runUserMutation callback (see adminUserValidation.ts's doc comment), not before
  // it's enqueued, so its target-level read can never go stale against a write that already
  // landed for the same discordId. This proves the check is re-evaluated fresh on every call
  // rather than being decided once up front — combined with runUserMutation's own strict
  // per-discordId serialization (tested in adminUserMutationQueue.test.ts/mutationQueue.test.ts),
  // that means a concurrent promotion landing between a Manager's stale read and their write can
  // no longer let a since-invalid edit through.
  it('re-checks authorization fresh on every call — rejects once the target has since been promoted', async () => {
    // First call: target is currently below the Manager's own level — allowed.
    vi.mocked(getMemberAccessLevel).mockResolvedValueOnce(AccessLevel.MOD);
    const first = await supertest(buildApp(MANAGER)).post('/users/update').type('form').send({ discord_id: VALID_ID, access_level: '1' });
    expect(first.headers.location).toBe('/admin/users');
    expect(vi.mocked(setMemberAccessLevel)).toHaveBeenCalledWith(GUILD_ID, VALID_ID, 1);

    // Simulates a concurrent Admin promotion landing between this Manager's original read and
    // this second, otherwise-identical request — a stale up-front check would have no way to
    // notice; the fresh in-callback check does.
    vi.mocked(getMemberAccessLevel).mockResolvedValueOnce(AccessLevel.ADMIN);
    const second = await supertest(buildApp(MANAGER)).post('/users/update').type('form').send({ discord_id: VALID_ID, access_level: '1' });
    expect(second.headers.location).toBe('/admin/users?error=target_above_level');
    // Only the first call's write should have gone through.
    expect(vi.mocked(setMemberAccessLevel)).toHaveBeenCalledTimes(1);
  });

  // Regression coverage for the actor-side TOCTOU (CodeRabbit finding on PR #657): the acting
  // Manager's own access level is re-read from the DB inside checkManagerEditAuth on every call,
  // not trusted from the sessionUser snapshot taken when the request came in. Simulates the
  // Manager themselves having been demoted (e.g. by an Admin) between two otherwise-identical
  // requests within the same session — the second must be re-authorized against their current,
  // lower DB level rather than reusing the higher level captured earlier in the session.
  it('re-checks the acting Manager\'s own access level fresh on every call — rejects once they have since been demoted', async () => {
    const first = await supertest(buildApp(MANAGER)).post('/users/update').type('form').send({ discord_id: VALID_ID, access_level: '1' });
    expect(first.headers.location).toBe('/admin/users');
    expect(vi.mocked(setMemberAccessLevel)).toHaveBeenCalledWith(GUILD_ID, VALID_ID, 1);

    // Simulates a concurrent demotion of the Manager themselves (e.g. to Mod) landing before this
    // second, otherwise-identical request's queued check runs.
    vi.mocked(getEffectiveAccessLevelForUser).mockImplementation(async (_guildId: string, user: { discord_id: string }) =>
      user.discord_id === MANAGER.discordId ? AccessLevel.MOD : AccessLevel.USER,
    );
    const second = await supertest(buildApp(MANAGER)).post('/users/update').type('form').send({ discord_id: VALID_ID, access_level: '1' });
    expect(second.headers.location).toBe('/admin/users?error=access_level_too_high');
    // Only the first call's write should have gone through.
    expect(vi.mocked(setMemberAccessLevel)).toHaveBeenCalledTimes(1);
  });

  // Structural proof that the authorization check lives *inside* the queued operation rather
  // than before it's enqueued: the buggy version called getMemberAccessLevel first and only
  // then called runUserMutation (so checkOrder < runOrder); the fixed version enters the queue
  // first and the check runs as part of the queued callback (so runOrder < checkOrder). Compares
  // mock.invocationCallOrder from a single request — no timing/concurrency simulation needed.
  it('runs the authorization check inside the queued operation, not before it is enqueued', async () => {
    vi.mocked(getMemberAccessLevel).mockResolvedValueOnce(AccessLevel.MOD);

    await supertest(buildApp(MANAGER)).post('/users/update').type('form').send({ discord_id: VALID_ID, access_level: '1' });

    const [runOrder] = mockQueueRun.mock.invocationCallOrder;
    const [checkOrder] = vi.mocked(getMemberAccessLevel).mock.invocationCallOrder;
    expect(runOrder).toBeLessThan(checkOrder);
  });
});

// --- POST /users/remove ---

describe('POST /users/remove', () => {
  it('redirects to /admin/users when discord_id is missing', async () => {
    const res = await supertest(buildApp()).post('/users/remove').type('form').send({});
    expect(res.headers.location).toBe('/admin/users');
  });

  it('redirects ?error=invalid_discord_id for an invalid ID', async () => {
    const res = await supertest(buildApp()).post('/users/remove').type('form').send({ discord_id: 'bad' });
    expect(res.headers.location).toBe('/admin/users?error=invalid_discord_id');
  });

  it('redirects ?error=self_remove_forbidden when removing self', async () => {
    const res = await supertest(buildApp(ADMIN)).post('/users/remove').type('form').send({ discord_id: ADMIN.discordId });
    expect(res.headers.location).toBe('/admin/users?error=self_remove_forbidden');
  });

  it('redirects ?error=db_busy on lock timeout', async () => {
    vi.mocked(removeGuildMember).mockRejectedValue(new Error('lock'));
    vi.mocked(isLockWaitTimeoutDbError).mockReturnValue(true);
    const res = await supertest(buildApp()).post('/users/remove').type('form').send({ discord_id: VALID_ID });
    expect(res.headers.location).toBe('/admin/users?error=db_busy');
  });

  it('redirects ?error=remove_failed on unexpected DB error', async () => {
    vi.mocked(removeGuildMember).mockRejectedValue(new Error('unexpected'));
    const res = await supertest(buildApp()).post('/users/remove').type('form').send({ discord_id: VALID_ID });
    expect(res.headers.location).toBe('/admin/users?error=remove_failed');
  });

  it('removes the member from the current guild and reloads the registry', async () => {
    const res = await supertest(buildApp()).post('/users/remove').type('form').send({ discord_id: VALID_ID });
    expect(res.headers.location).toBe('/admin/users');
    expect(vi.mocked(removeGuildMember)).toHaveBeenCalledWith(GUILD_ID, VALID_ID);
    expect(vi.mocked(reloadGuildRegistry)).toHaveBeenCalled();
  });

  // Regression coverage for the actor-side TOCTOU on removal (CodeRabbit finding on PR #657):
  // requireAdmin only checks the session's access level at request time, before the operation
  // waits on the mutation queue — the acting admin's own access level is re-read fresh from the
  // DB inside the guarded operation, not trusted from the session, so a demotion of the actor
  // between the request landing and the queued removal running is caught.
  it('re-checks the acting Admin\'s own access level fresh — rejects once they have since been demoted, without removing', async () => {
    vi.mocked(getEffectiveAccessLevelForUser).mockImplementation(async (_guildId: string, user: { discord_id: string }) =>
      user.discord_id === ADMIN.discordId ? AccessLevel.MANAGER : AccessLevel.USER,
    );
    const res = await supertest(buildApp(ADMIN)).post('/users/remove').type('form').send({ discord_id: VALID_ID });
    expect(res.headers.location).toBe('/admin/users?error=target_above_level');
    expect(vi.mocked(removeGuildMember)).not.toHaveBeenCalled();
    expect(vi.mocked(reloadGuildRegistry)).not.toHaveBeenCalled();
  });
});

// --- POST /users/toggle-twitch ---

describe('POST /users/toggle-twitch', () => {
  beforeEach(() => {
    // Target user is a member of the current guild by default.
    vi.mocked(getMemberAccessLevel).mockResolvedValue(0);
  });

  it('redirects to /admin/users when discord_id is missing', async () => {
    const res = await supertest(buildApp()).post('/users/toggle-twitch').type('form').send({ is_twitch_bot_enabled: 'true' });
    expect(res.headers.location).toBe('/admin/users');
  });

  it('redirects ?error=invalid_discord_id for an invalid ID', async () => {
    const res = await supertest(buildApp()).post('/users/toggle-twitch').type('form')
      .send({ discord_id: 'bad', is_twitch_bot_enabled: 'true' });
    expect(res.headers.location).toBe('/admin/users?error=invalid_discord_id');
  });

  it('redirects ?error=target_above_level when target is not a member of the current guild', async () => {
    vi.mocked(getMemberAccessLevel).mockResolvedValue(null);
    const res = await supertest(buildApp()).post('/users/toggle-twitch').type('form')
      .send({ discord_id: VALID_ID, is_twitch_bot_enabled: 'true' });
    expect(res.headers.location).toBe('/admin/users?error=target_above_level');
    expect(vi.mocked(toggleTwitchMutation)).not.toHaveBeenCalled();
  });

  it('redirects ?error=invalid_twitch_state for an unrecognised value', async () => {
    const res = await supertest(buildApp()).post('/users/toggle-twitch').type('form')
      .send({ discord_id: VALID_ID, is_twitch_bot_enabled: 'maybe' });
    expect(res.headers.location).toBe('/admin/users?error=invalid_twitch_state');
  });

  it('enables with is_twitch_bot_enabled=true', async () => {
    const res = await supertest(buildApp()).post('/users/toggle-twitch').type('form')
      .send({ discord_id: VALID_ID, is_twitch_bot_enabled: 'true' });
    expect(res.headers.location).toBe('/admin/users');
    expect(vi.mocked(toggleTwitchMutation)).toHaveBeenCalledWith(VALID_ID, true);
  });

  it('disables with is_twitch_bot_enabled=false', async () => {
    const res = await supertest(buildApp()).post('/users/toggle-twitch').type('form')
      .send({ discord_id: VALID_ID, is_twitch_bot_enabled: 'false' });
    expect(res.headers.location).toBe('/admin/users');
    expect(vi.mocked(toggleTwitchMutation)).toHaveBeenCalledWith(VALID_ID, false);
  });

  it('redirects ?error=db_busy on lock timeout', async () => {
    vi.mocked(toggleTwitchMutation).mockRejectedValue(new Error('lock'));
    vi.mocked(isLockWaitTimeoutDbError).mockReturnValue(true);
    const res = await supertest(buildApp()).post('/users/toggle-twitch').type('form')
      .send({ discord_id: VALID_ID, is_twitch_bot_enabled: 'true' });
    expect(res.headers.location).toBe('/admin/users?error=db_busy');
  });

  it('redirects ?error=toggle_failed on unexpected DB error', async () => {
    vi.mocked(toggleTwitchMutation).mockRejectedValue(new Error('unexpected'));
    const res = await supertest(buildApp()).post('/users/toggle-twitch').type('form')
      .send({ discord_id: VALID_ID, is_twitch_bot_enabled: 'true' });
    expect(res.headers.location).toBe('/admin/users?error=toggle_failed');
  });
});
