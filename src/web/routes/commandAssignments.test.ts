import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mockLogger } from '../../test-utils/loggerMock';
import { ACCESS_LEVEL_MOCK } from '../../test-utils/accessLevelMock';

vi.mock('../../db', () => {
  class CommandConflictError extends Error {}
  return {
    assignUserToCommand: vi.fn().mockResolvedValue(undefined),
    unassignUserFromCommand: vi.fn().mockResolvedValue(undefined),
    findUser: vi.fn().mockResolvedValue(null),
    CommandConflictError,
    isMysqlDuplicateEntryError: vi.fn().mockReturnValue(false),
    AccessLevel: ACCESS_LEVEL_MOCK,
  };
});
vi.mock('../csrf', () => ({
  csrfProtection: (_req: any, _res: any, next: any) => next(),
}));
const { middlewareCallOrder } = vi.hoisted(() => ({ middlewareCallOrder: [] as string[] }));
vi.mock('../middleware', () => ({
  requireGuildContext: (_req: any, _res: any, next: any) => { middlewareCallOrder.push('requireGuildContext'); next(); },
  requireMod: (_req: any, _res: any, next: any) => { middlewareCallOrder.push('requireMod'); next(); },
}));
vi.mock('../../shared/logger', () => ({ createLogger: mockLogger }));

import supertest from 'supertest';
import router from './commandAssignments';
import { assignUserToCommand, unassignUserFromCommand, findUser, CommandConflictError, isMysqlDuplicateEntryError } from '../../db';
import { AccessLevel } from '../../db';
import { buildTestApp } from '../../test-utils/expressTestApp';

/** Builds a supertest-ready app: the command assignments router with a urlencoded body parser (no session or render stub needed). */
function buildApp() {
  return buildTestApp({ router, bodyParser: 'urlencoded' });
}

const VALID_COMMAND_ID = '5';
const VALID_DISCORD_ID = '123456789012345678'; // 18 digits

beforeEach(() => {
  vi.clearAllMocks();
  middlewareCallOrder.length = 0;
  vi.mocked(findUser).mockResolvedValue({ discord_id: VALID_DISCORD_ID, discord_name: 'Alice', is_twitch_bot_enabled: true, twitch_name: 'alice', access_level: AccessLevel.USER } as any);
  vi.mocked(assignUserToCommand).mockResolvedValue(undefined);
  vi.mocked(unassignUserFromCommand).mockResolvedValue(undefined);
  vi.mocked(isMysqlDuplicateEntryError).mockReturnValue(false);
});

// ─── POST /commands/assign ────────────────────────────────────────────────────

describe('POST /commands/assign', () => {
  it('runs requireGuildContext before requireMod, so a demoted session is re-checked with a fresh access level', async () => {
    await supertest(buildApp())
      .post('/commands/assign')
      .send(`command_id=${VALID_COMMAND_ID}&discord_id=${VALID_DISCORD_ID}`);
    expect(middlewareCallOrder).toEqual(['requireGuildContext', 'requireMod']);
  });

  it('redirects to /commands on success', async () => {
    const res = await supertest(buildApp())
      .post('/commands/assign')
      .send(`command_id=${VALID_COMMAND_ID}&discord_id=${VALID_DISCORD_ID}`);
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/commands');
  });

  it('redirects to ?error=missing_fields when fields are absent', async () => {
    const res = await supertest(buildApp()).post('/commands/assign').send('');
    expect(res.headers.location).toBe('/commands?error=missing_fields');
  });

  it('redirects to ?error=invalid_id for non-numeric command_id', async () => {
    const res = await supertest(buildApp())
      .post('/commands/assign')
      .send(`command_id=abc&discord_id=${VALID_DISCORD_ID}`);
    expect(res.headers.location).toBe('/commands?error=invalid_id');
  });

  it('redirects to ?error=invalid_id for invalid discord_id', async () => {
    const res = await supertest(buildApp())
      .post('/commands/assign')
      .send(`command_id=${VALID_COMMAND_ID}&discord_id=bad`);
    expect(res.headers.location).toBe('/commands?error=invalid_id');
  });

  it('redirects to ?error=invalid_assignment_user when user not found', async () => {
    vi.mocked(findUser).mockResolvedValue(null);
    const res = await supertest(buildApp())
      .post('/commands/assign')
      .send(`command_id=${VALID_COMMAND_ID}&discord_id=${VALID_DISCORD_ID}`);
    expect(res.headers.location).toBe('/commands?error=invalid_assignment_user');
  });

  it('redirects to ?error=invalid_assignment_user when user has no twitch_name', async () => {
    vi.mocked(findUser).mockResolvedValue({ discord_id: VALID_DISCORD_ID, discord_name: 'Alice', is_twitch_bot_enabled: false, twitch_name: null, access_level: AccessLevel.USER } as any);
    const res = await supertest(buildApp())
      .post('/commands/assign')
      .send(`command_id=${VALID_COMMAND_ID}&discord_id=${VALID_DISCORD_ID}`);
    expect(res.headers.location).toBe('/commands?error=invalid_assignment_user');
  });

  it('redirects to ?error=command_taken when CommandConflictError is thrown', async () => {
    vi.mocked(assignUserToCommand).mockRejectedValueOnce(new (CommandConflictError as any)('conflict'));
    const res = await supertest(buildApp())
      .post('/commands/assign')
      .send(`command_id=${VALID_COMMAND_ID}&discord_id=${VALID_DISCORD_ID}`);
    expect(res.headers.location).toBe('/commands?error=command_taken');
  });

  it('redirects to ?error=command_taken when isMysqlDuplicateEntryError returns true', async () => {
    vi.mocked(isMysqlDuplicateEntryError).mockReturnValue(true);
    vi.mocked(assignUserToCommand).mockRejectedValueOnce(new Error('ER_DUP_ENTRY'));
    const res = await supertest(buildApp())
      .post('/commands/assign')
      .send(`command_id=${VALID_COMMAND_ID}&discord_id=${VALID_DISCORD_ID}`);
    expect(res.headers.location).toBe('/commands?error=command_taken');
  });

  it('redirects to ?error=assign_failed on unexpected error', async () => {
    vi.mocked(assignUserToCommand).mockRejectedValueOnce(new Error('unexpected'));
    const res = await supertest(buildApp())
      .post('/commands/assign')
      .send(`command_id=${VALID_COMMAND_ID}&discord_id=${VALID_DISCORD_ID}`);
    expect(res.headers.location).toBe('/commands?error=assign_failed');
  });
});

// ─── POST /commands/unassign ──────────────────────────────────────────────────

describe('POST /commands/unassign', () => {
  it('runs requireGuildContext before requireMod, so a demoted session is re-checked with a fresh access level', async () => {
    await supertest(buildApp())
      .post('/commands/unassign')
      .send(`command_id=${VALID_COMMAND_ID}&discord_id=${VALID_DISCORD_ID}`);
    expect(middlewareCallOrder).toEqual(['requireGuildContext', 'requireMod']);
  });

  it('redirects to /commands on success', async () => {
    const res = await supertest(buildApp())
      .post('/commands/unassign')
      .send(`command_id=${VALID_COMMAND_ID}&discord_id=${VALID_DISCORD_ID}`);
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/commands');
  });

  it('redirects to ?error=missing_fields when fields are absent', async () => {
    const res = await supertest(buildApp()).post('/commands/unassign').send('');
    expect(res.headers.location).toBe('/commands?error=missing_fields');
  });

  it('redirects to ?error=invalid_id for non-numeric command_id', async () => {
    const res = await supertest(buildApp())
      .post('/commands/unassign')
      .send(`command_id=abc&discord_id=${VALID_DISCORD_ID}`);
    expect(res.headers.location).toBe('/commands?error=invalid_id');
  });

  it('redirects to ?error=invalid_id for malformed discord_id', async () => {
    const res = await supertest(buildApp())
      .post('/commands/unassign')
      .send(`command_id=${VALID_COMMAND_ID}&discord_id=bad`);
    expect(res.headers.location).toBe('/commands?error=invalid_id');
  });

  it('redirects to ?error=unassign_failed on unexpected error', async () => {
    vi.mocked(unassignUserFromCommand).mockRejectedValueOnce(new Error('db error'));
    const res = await supertest(buildApp())
      .post('/commands/unassign')
      .send(`command_id=${VALID_COMMAND_ID}&discord_id=${VALID_DISCORD_ID}`);
    expect(res.headers.location).toBe('/commands?error=unassign_failed');
  });
});
