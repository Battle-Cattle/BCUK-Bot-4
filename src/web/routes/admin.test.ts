import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../db', () => ({
  findUser: vi.fn(),
  getMemberAccessLevel: vi.fn(),
  getGuildMemberUsers: vi.fn(),
  setMemberAccessLevel: vi.fn(),
  removeGuildMember: vi.fn(),
  ACCESS_LEVEL_LABELS: { 0: 'User', 1: 'Mod', 2: 'Manager', 3: 'Admin' },
  AccessLevel: { USER: 0, MOD: 1, MANAGER: 2, ADMIN: 3 },
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
import { findUser, getMemberAccessLevel, getGuildMemberUsers, setMemberAccessLevel, removeGuildMember } from '../../db';
import { reloadGuildRegistry } from '../../discord/guildRegistry';
import { AccessLevel } from '../../db/users';
import { normalizeTwitchChannelName } from '../../twitch/twitchChannelName';
import {
  DuplicateTwitchNameError,
  isDuplicateTwitchNameDbError,
  isLockWaitTimeoutDbError,
  addOrUpdateUserMutation,
  toggleTwitchMutation,
} from './adminUserMutations';

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
  vi.mocked(getGuildMemberUsers).mockResolvedValue([]);
  vi.mocked(findUser).mockResolvedValue(null);
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
