import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mockLogger } from '../../test-utils/loggerMock';

vi.mock('../middleware', () => ({
  requireApiKey: (req: any, _res: any, next: any) => {
    req.apiKeyOwner = 'owner-1';
    next();
  },
}));
vi.mock('../../db', () => ({
  getApprovedGuildIdsForKey: vi.fn(),
  getStreamerByDiscordId: vi.fn(),
  listAdvancedCommands: vi.fn(),
  setAdvancedCommandEnabled: vi.fn(),
}));
vi.mock('../../commands/advancedCommands/advancedCommandHandler', () => ({ triggerAdvancedCommandFromStreamDeck: vi.fn() }));
vi.mock('../../shared/logger', () => ({ createLogger: mockLogger }));

import supertest from 'supertest';
import router from './streamdeckAdvancedCommands';
import { getApprovedGuildIdsForKey, getStreamerByDiscordId, listAdvancedCommands, setAdvancedCommandEnabled } from '../../db';
import { triggerAdvancedCommandFromStreamDeck } from '../../commands/advancedCommands/advancedCommandHandler';
import { buildTestApp } from '../../test-utils/expressTestApp';

const app = () => buildTestApp({ router, bodyParser: 'json' });

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getApprovedGuildIdsForKey).mockResolvedValue(['g1']);
  vi.mocked(getStreamerByDiscordId).mockResolvedValue({ id: 3, discord_id: 'owner-1', twitch_name: 'Streamer' } as any);
  vi.mocked(triggerAdvancedCommandFromStreamDeck).mockResolvedValue('ok');
});

describe('GET /advanced-commands', () => {
  it('lists the key owner\'s commands', async () => {
    vi.mocked(listAdvancedCommands).mockResolvedValue([
      { id: 7, name: 'Hydrate', triggerString: null, pointCost: 0, isEnabled: false } as any,
    ]);
    const res = await supertest(app()).get('/advanced-commands').expect(200);
    expect(res.body).toEqual({ ok: true, commands: [{ id: 7, name: 'Hydrate', trigger: null, pointCost: 0, isEnabled: false }] });
    expect(listAdvancedCommands).toHaveBeenCalledWith(3);
  });

  it('refuses an unapproved key or a non-streamer', async () => {
    vi.mocked(getApprovedGuildIdsForKey).mockResolvedValueOnce([]);
    {
      const r = await supertest(app()).get('/advanced-commands');
      expect(r.status).toBe(403);
    }
    vi.mocked(getStreamerByDiscordId).mockResolvedValueOnce({ id: 3, twitch_name: null } as any);
    const res = await supertest(app()).get('/advanced-commands').expect(403);
    expect(res.body.error).toBe('not_a_streamer');
  });

  it('returns 500 on a DB error', async () => {
    vi.mocked(listAdvancedCommands).mockRejectedValue(new Error('boom'));
    {
      const r = await supertest(app()).get('/advanced-commands');
      expect(r.status).toBe(500);
    }
  });
});

describe('POST /advanced-commands/trigger', () => {
  it('fires the command for the key owner\'s streamer', async () => {
    {
      const r = await supertest(app()).post('/advanced-commands/trigger').send({ commandId: 7 });
      expect(r.status).toBe(200);
      expect(r.body).toEqual({ ok: true });
    }
    expect(triggerAdvancedCommandFromStreamDeck).toHaveBeenCalledWith({ id: 3, discordId: 'owner-1', twitchName: 'Streamer' }, 7);
  });

  it('accepts a numeric string id', async () => {
    {
      const r = await supertest(app()).post('/advanced-commands/trigger').send({ commandId: '7' });
      expect(r.status).toBe(200);
    }
  });

  it.each([[{}], [{ commandId: 0 }], [{ commandId: 'abc' }], [{ commandId: 1.5 }]])('rejects %o', async (body) => {
    {
      const r = await supertest(app()).post('/advanced-commands/trigger').send(body);
      expect(r.status).toBe(400);
    }
  });

  it.each([
    ['command_not_found', 404],
    ['command_disabled', 409],
  ] as const)('maps %s to %i', async (result, status) => {
    vi.mocked(triggerAdvancedCommandFromStreamDeck).mockResolvedValue(result);
    const res = await supertest(app()).post('/advanced-commands/trigger').send({ commandId: 7 }).expect(status);
    expect(res.body).toEqual({ ok: false, error: result });
  });

  it('refuses a non-streamer and reports errors', async () => {
    vi.mocked(getStreamerByDiscordId).mockResolvedValueOnce(null);
    {
      const r = await supertest(app()).post('/advanced-commands/trigger').send({ commandId: 7 });
      expect(r.status).toBe(403);
    }
    vi.mocked(triggerAdvancedCommandFromStreamDeck).mockRejectedValue(new Error('boom'));
    {
      const r = await supertest(app()).post('/advanced-commands/trigger').send({ commandId: 7 });
      expect(r.status).toBe(500);
    }
  });
});

describe('POST /advanced-commands/enabled', () => {
  it('toggles when enabled is omitted and sets it when given', async () => {
    vi.mocked(setAdvancedCommandEnabled).mockResolvedValue(true);
    {
      const r = await supertest(app()).post('/advanced-commands/enabled').send({ commandId: 7 });
      expect(r.status).toBe(200);
      expect(r.body).toEqual({ ok: true, isEnabled: true });
    }
    expect(setAdvancedCommandEnabled).toHaveBeenCalledWith(3, 7, undefined);
    {
      const r = await supertest(app()).post('/advanced-commands/enabled').send({ commandId: 7, enabled: false });
      expect(r.status).toBe(200);
    }
    expect(setAdvancedCommandEnabled).toHaveBeenLastCalledWith(3, 7, false);
  });

  it('rejects a non-boolean enabled, and 404s an unknown command', async () => {
    {
      const r = await supertest(app()).post('/advanced-commands/enabled').send({ commandId: 7, enabled: 'yes' });
      expect(r.status).toBe(400);
    }
    vi.mocked(setAdvancedCommandEnabled).mockResolvedValue(null);
    {
      const r = await supertest(app()).post('/advanced-commands/enabled').send({ commandId: 7 });
      expect(r.status).toBe(404);
    }
  });

  it('refuses a non-streamer and reports errors', async () => {
    vi.mocked(getApprovedGuildIdsForKey).mockResolvedValueOnce([]);
    {
      const r = await supertest(app()).post('/advanced-commands/enabled').send({ commandId: 7 });
      expect(r.status).toBe(403);
    }
    vi.mocked(setAdvancedCommandEnabled).mockRejectedValue(new Error('boom'));
    {
      const r = await supertest(app()).post('/advanced-commands/enabled').send({ commandId: 7 });
      expect(r.status).toBe(500);
    }
  });
});
