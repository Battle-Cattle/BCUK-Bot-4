import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../db', () => ({
  upsertOverride: vi.fn().mockResolvedValue(undefined),
  removeOverride: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../csrf', () => ({ csrfProtection: (_req: any, _res: any, next: any) => next() }));
vi.mock('../middleware', () => ({
  requireMod: (_req: any, _res: any, next: any) => next(),
  requireGuildContext: (_req: any, _res: any, next: any) => next(),
}));
vi.mock('../../shared/logger', () => ({ createLogger: () => ({ info: vi.fn(), error: vi.fn(), warn: vi.fn() }) }));

import express from 'express';
import supertest from 'supertest';
import router from './commandGuildOverrides';
import { upsertOverride, removeOverride } from '../../db';

const GUILD_ID = '900000000000000001';

function buildApp(currentGuildId: string | null = GUILD_ID) {
  const app = express();
  app.use(express.urlencoded({ extended: false }));
  app.use((req: any, _res: any, next: any) => {
    req.session = { user: { discordId: 'u1', currentGuildId } };
    next();
  });
  app.use(router);
  return app;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(upsertOverride).mockResolvedValue(undefined);
  vi.mocked(removeOverride).mockResolvedValue(undefined);
});

// ─── POST /commands/guild-override ────────────────────────────────────────────

describe('POST /commands/guild-override', () => {
  it('calls upsertOverride with session guild and redirects to /commands', async () => {
    const res = await supertest(buildApp())
      .post('/commands/guild-override')
      .send('command_id=5&is_disabled=1');
    expect(res.headers.location).toBe('/commands');
    expect(vi.mocked(upsertOverride)).toHaveBeenCalledWith(GUILD_ID, 5, {
      isDisabled: true,
      output: null,
    });
  });

  it('stores a custom output when provided', async () => {
    await supertest(buildApp())
      .post('/commands/guild-override')
      .send('command_id=5&output=Hello+there');
    expect(vi.mocked(upsertOverride)).toHaveBeenCalledWith(GUILD_ID, 5, {
      isDisabled: false,
      output: 'Hello there',
    });
  });

  it('clears custom output when clear_output is set', async () => {
    await supertest(buildApp())
      .post('/commands/guild-override')
      .send('command_id=5&output=Something&clear_output=1');
    expect(vi.mocked(upsertOverride)).toHaveBeenCalledWith(GUILD_ID, 5, {
      isDisabled: false,
      output: null,
    });
  });

  it('returns 302 to ?error=invalid_id for a non-integer command_id', async () => {
    const res = await supertest(buildApp())
      .post('/commands/guild-override')
      .send('command_id=abc');
    expect(res.headers.location).toBe('/commands?error=invalid_id');
    expect(vi.mocked(upsertOverride)).not.toHaveBeenCalled();
  });

  it('redirects to ?error=override_failed when upsertOverride throws', async () => {
    vi.mocked(upsertOverride).mockRejectedValue(new Error('DB error'));
    const res = await supertest(buildApp())
      .post('/commands/guild-override')
      .send('command_id=5');
    expect(res.headers.location).toBe('/commands?error=override_failed');
  });
});

// ─── POST /commands/guild-override/reset ─────────────────────────────────────

describe('POST /commands/guild-override/reset', () => {
  it('calls removeOverride with session guild and redirects to /commands', async () => {
    const res = await supertest(buildApp())
      .post('/commands/guild-override/reset')
      .send('command_id=5');
    expect(res.headers.location).toBe('/commands');
    expect(vi.mocked(removeOverride)).toHaveBeenCalledWith(GUILD_ID, 5);
  });

  it('returns 302 to ?error=invalid_id for a non-integer command_id', async () => {
    const res = await supertest(buildApp())
      .post('/commands/guild-override/reset')
      .send('command_id=abc');
    expect(res.headers.location).toBe('/commands?error=invalid_id');
    expect(vi.mocked(removeOverride)).not.toHaveBeenCalled();
  });

  it('redirects to ?error=override_reset_failed when removeOverride throws', async () => {
    vi.mocked(removeOverride).mockRejectedValue(new Error('DB error'));
    const res = await supertest(buildApp())
      .post('/commands/guild-override/reset')
      .send('command_id=5');
    expect(res.headers.location).toBe('/commands?error=override_reset_failed');
  });
});
