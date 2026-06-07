import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../db', () => ({
  findUser: vi.fn(),
  getAllUsers: vi.fn(),
  updateAccessLevel: vi.fn(),
  ACCESS_LEVEL_LABELS: { 0: 'User', 1: 'Mod', 2: 'Manager', 3: 'Admin' },
  AccessLevel: { USER: 0, MOD: 1, MANAGER: 2, ADMIN: 3 },
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

vi.mock('../../shared/mutationQueue', () => ({
  createMutationQueue: () => ({
    run: (_key: string, fn: () => Promise<unknown>) => fn(),
  }),
}));

vi.mock('./adminRefresh', async () => {
  const { Router } = await import('express');
  return {
    default: Router(),
    refreshState: { outcome: 'idle', updatedCount: 0, failureCount: 0, startedAt: null, finishedAt: null },
  };
});

vi.mock('./adminUserMutations', () => {
  class DuplicateTwitchNameError extends Error {}
  return {
    DuplicateTwitchNameError,
    isDuplicateTwitchNameDbError: vi.fn().mockReturnValue(false),
    isLockWaitTimeoutDbError: vi.fn().mockReturnValue(false),
    addOrUpdateUserMutation: vi.fn().mockResolvedValue(undefined),
    removeUserMutation: vi.fn().mockResolvedValue(undefined),
    toggleTwitchMutation: vi.fn().mockResolvedValue(undefined),
  };
});

vi.mock('../../shared/logger', () => ({
  createLogger: () => ({ info: vi.fn(), error: vi.fn(), warn: vi.fn() }),
}));

vi.mock('../../db/users', () => ({ AccessLevel: { USER: 0, MOD: 1, MANAGER: 2, ADMIN: 3 } }));

import express from 'express';
import supertest from 'supertest';
import router from './admin';
import { findUser, getAllUsers, updateAccessLevel } from '../../db';
import { AccessLevel } from '../../db/users';
import { normalizeTwitchChannelName } from '../../twitch/twitchChannelName';
import {
  DuplicateTwitchNameError,
  isDuplicateTwitchNameDbError,
  isLockWaitTimeoutDbError,
  addOrUpdateUserMutation,
  removeUserMutation,
  toggleTwitchMutation,
} from './adminUserMutations';

type SessionUser = { discordId: string; discordName: string; discordAvatar: string | null; accessLevel: 0 | 1 | 2 | 3 };

const ADMIN: SessionUser = { discordId: '100000000000000001', discordName: 'AdminUser', discordAvatar: null, accessLevel: AccessLevel.ADMIN };
const MANAGER: SessionUser = { discordId: '200000000000000001', discordName: 'ManagerUser', discordAvatar: null, accessLevel: AccessLevel.MANAGER };
const VALID_ID = '300000000000000001';

function buildApp(sessionUser: SessionUser = ADMIN) {
  const app = express();
  app.use(express.urlencoded({ extended: false }));
  app.use((req: any, res: any, next: any) => {
    req.session = { user: sessionUser };
    res.render = (view: string, locals?: any) => res.json({ view, ...locals });
    next();
  });
  app.use(router);
  return app;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getAllUsers).mockResolvedValue([]);
  vi.mocked(findUser).mockResolvedValue(null);
  vi.mocked(updateAccessLevel).mockResolvedValue(undefined);
  vi.mocked(addOrUpdateUserMutation).mockResolvedValue(undefined);
  vi.mocked(removeUserMutation).mockResolvedValue(undefined);
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

  it('returns 500 when getAllUsers throws', async () => {
    vi.mocked(getAllUsers).mockRejectedValue(new Error('DB down'));
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

  it('redirects ?error=invalid_discord_id for a short ID', async () => {
    const res = await supertest(buildApp()).post('/users/add').type('form').send({ discord_id: '1234', access_level: '0' });
    expect(res.headers.location).toBe('/admin/users?error=invalid_discord_id');
  });

  it('redirects ?error=invalid_discord_id for a non-numeric ID', async () => {
    const res = await supertest(buildApp()).post('/users/add').type('form').send({ discord_id: 'not-an-id-xxxx', access_level: '0' });
    expect(res.headers.location).toBe('/admin/users?error=invalid_discord_id');
  });

  it('redirects ?error=invalid_access_level for a non-numeric access_level', async () => {
    const res = await supertest(buildApp()).post('/users/add').type('form').send({ discord_id: VALID_ID, access_level: 'admin' });
    expect(res.headers.location).toBe('/admin/users?error=invalid_access_level');
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

  it('skips twitch validation when clear_twitch_name=1', async () => {
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

  it('redirects ?error=access_level_too_high when manager tries to grant own level', async () => {
    const res = await supertest(buildApp(MANAGER)).post('/users/add').type('form')
      .send({ discord_id: VALID_ID, access_level: '2' }); // MANAGER is level 2
    expect(res.headers.location).toBe('/admin/users?error=access_level_too_high');
  });

  it('redirects ?error=target_above_level when manager edits a user at their own level', async () => {
    vi.mocked(findUser).mockResolvedValue({ access_level: AccessLevel.MANAGER } as any); // target at manager's level
    const res = await supertest(buildApp(MANAGER)).post('/users/add').type('form')
      .send({ discord_id: VALID_ID, access_level: '1' }); // granting level 1 (below manager) is otherwise valid
    expect(res.headers.location).toBe('/admin/users?error=target_above_level');
  });

  it('admin bypasses the manager permission checks', async () => {
    vi.mocked(findUser).mockResolvedValue({ access_level: AccessLevel.ADMIN } as any);
    const res = await supertest(buildApp(ADMIN)).post('/users/add').type('form')
      .send({ discord_id: VALID_ID, access_level: '3' });
    expect(res.headers.location).toBe('/admin/users');
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

  it('redirects to /admin/users on success', async () => {
    const res = await supertest(buildApp()).post('/users/add').type('form')
      .send({ discord_id: VALID_ID, discord_name: 'TestUser', access_level: '0', twitch_name: 'streamer' });
    expect(res.headers.location).toBe('/admin/users');
    expect(vi.mocked(addOrUpdateUserMutation)).toHaveBeenCalledWith(
      expect.objectContaining({ discordId: VALID_ID, discordName: 'TestUser', level: 0, normalizedTwitchName: 'streamer' }),
    );
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

  it('redirects ?error=invalid_access_level for a non-numeric level', async () => {
    const res = await supertest(buildApp()).post('/users/update').type('form').send({ discord_id: VALID_ID, access_level: 'bad' });
    expect(res.headers.location).toBe('/admin/users?error=invalid_access_level');
  });

  it('redirects ?error=invalid_access_level for an out-of-range level', async () => {
    const res = await supertest(buildApp()).post('/users/update').type('form').send({ discord_id: VALID_ID, access_level: '5' });
    expect(res.headers.location).toBe('/admin/users?error=invalid_access_level');
  });

  it('redirects ?error=self_edit_forbidden when editing self', async () => {
    const res = await supertest(buildApp(ADMIN)).post('/users/update').type('form')
      .send({ discord_id: ADMIN.discordId, access_level: '0' });
    expect(res.headers.location).toBe('/admin/users?error=self_edit_forbidden');
  });

  it('redirects ?error=access_level_too_high when manager tries to grant own level', async () => {
    const res = await supertest(buildApp(MANAGER)).post('/users/update').type('form')
      .send({ discord_id: VALID_ID, access_level: '2' });
    expect(res.headers.location).toBe('/admin/users?error=access_level_too_high');
  });

  it('redirects ?error=target_above_level when manager edits user at their level', async () => {
    vi.mocked(findUser).mockResolvedValue({ access_level: AccessLevel.MANAGER } as any);
    const res = await supertest(buildApp(MANAGER)).post('/users/update').type('form')
      .send({ discord_id: VALID_ID, access_level: '1' });
    expect(res.headers.location).toBe('/admin/users?error=target_above_level');
  });

  it('redirects ?error=db_busy on lock timeout', async () => {
    vi.mocked(updateAccessLevel).mockRejectedValue(new Error('lock'));
    vi.mocked(isLockWaitTimeoutDbError).mockReturnValue(true);
    const res = await supertest(buildApp()).post('/users/update').type('form').send({ discord_id: VALID_ID, access_level: '0' });
    expect(res.headers.location).toBe('/admin/users?error=db_busy');
  });

  it('redirects ?error=update_failed on unexpected DB error', async () => {
    vi.mocked(updateAccessLevel).mockRejectedValue(new Error('unexpected'));
    const res = await supertest(buildApp()).post('/users/update').type('form').send({ discord_id: VALID_ID, access_level: '0' });
    expect(res.headers.location).toBe('/admin/users?error=update_failed');
  });

  it('redirects to /admin/users on success', async () => {
    const res = await supertest(buildApp()).post('/users/update').type('form').send({ discord_id: VALID_ID, access_level: '1' });
    expect(res.headers.location).toBe('/admin/users');
    expect(vi.mocked(updateAccessLevel)).toHaveBeenCalledWith(VALID_ID, 1);
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
    vi.mocked(removeUserMutation).mockRejectedValue(new Error('lock'));
    vi.mocked(isLockWaitTimeoutDbError).mockReturnValue(true);
    const res = await supertest(buildApp()).post('/users/remove').type('form').send({ discord_id: VALID_ID });
    expect(res.headers.location).toBe('/admin/users?error=db_busy');
  });

  it('redirects ?error=remove_failed on unexpected DB error', async () => {
    vi.mocked(removeUserMutation).mockRejectedValue(new Error('unexpected'));
    const res = await supertest(buildApp()).post('/users/remove').type('form').send({ discord_id: VALID_ID });
    expect(res.headers.location).toBe('/admin/users?error=remove_failed');
  });

  it('redirects to /admin/users on success', async () => {
    const res = await supertest(buildApp()).post('/users/remove').type('form').send({ discord_id: VALID_ID });
    expect(res.headers.location).toBe('/admin/users');
    expect(vi.mocked(removeUserMutation)).toHaveBeenCalledWith(VALID_ID);
  });
});

// --- POST /users/toggle-twitch ---

describe('POST /users/toggle-twitch', () => {
  it('redirects to /admin/users when discord_id is missing', async () => {
    const res = await supertest(buildApp()).post('/users/toggle-twitch').type('form').send({ is_twitch_bot_enabled: 'true' });
    expect(res.headers.location).toBe('/admin/users');
  });

  it('redirects ?error=invalid_discord_id for an invalid ID', async () => {
    const res = await supertest(buildApp()).post('/users/toggle-twitch').type('form')
      .send({ discord_id: 'bad', is_twitch_bot_enabled: 'true' });
    expect(res.headers.location).toBe('/admin/users?error=invalid_discord_id');
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

  it('enables with is_twitch_bot_enabled=1', async () => {
    const res = await supertest(buildApp()).post('/users/toggle-twitch').type('form')
      .send({ discord_id: VALID_ID, is_twitch_bot_enabled: '1' });
    expect(res.headers.location).toBe('/admin/users');
    expect(vi.mocked(toggleTwitchMutation)).toHaveBeenCalledWith(VALID_ID, true);
  });

  it('disables with is_twitch_bot_enabled=false', async () => {
    const res = await supertest(buildApp()).post('/users/toggle-twitch').type('form')
      .send({ discord_id: VALID_ID, is_twitch_bot_enabled: 'false' });
    expect(res.headers.location).toBe('/admin/users');
    expect(vi.mocked(toggleTwitchMutation)).toHaveBeenCalledWith(VALID_ID, false);
  });

  it('disables with is_twitch_bot_enabled=0', async () => {
    const res = await supertest(buildApp()).post('/users/toggle-twitch').type('form')
      .send({ discord_id: VALID_ID, is_twitch_bot_enabled: '0' });
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
