import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mockLogger } from '../../test-utils/loggerMock';

vi.mock('../middleware', () => ({
  requireCompanionKey: (req: any, _res: any, next: any) => {
    req.companionDiscordId = 'user-1';
    next();
  },
}));
vi.mock('../../db', () => ({
  getStreamerByDiscordId: vi.fn(),
  listAdvancedCommands: vi.fn(),
  getAdvancedCommandUsageStreamerId: vi.fn(),
}));
vi.mock('../../commands/advancedCommands/advancedCommandRefunds', () => ({
  acknowledgeAdvancedCommandUse: vi.fn(),
  extendAdvancedCommandAck: vi.fn(),
}));
vi.mock('../../shared/logger', () => ({ createLogger: mockLogger }));

import supertest from 'supertest';
import router from './companionCommands';
import { getStreamerByDiscordId, listAdvancedCommands, getAdvancedCommandUsageStreamerId } from '../../db';
import { acknowledgeAdvancedCommandUse, extendAdvancedCommandAck } from '../../commands/advancedCommands/advancedCommandRefunds';
import { buildTestApp } from '../../test-utils/expressTestApp';

const EVENT_ID = '3f2b8c1e-4d5a-4b6c-8d7e-9f0a1b2c3d4e';
const app = () => buildTestApp({ router, bodyParser: 'json' });

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getStreamerByDiscordId).mockResolvedValue({ id: 3 } as any);
  vi.mocked(getAdvancedCommandUsageStreamerId).mockResolvedValue(3);
  vi.mocked(acknowledgeAdvancedCommandUse).mockResolvedValue(true);
});

describe('GET /commands', () => {
  it('lists the streamer\'s commands with their parameters', async () => {
    vi.mocked(listAdvancedCommands).mockResolvedValue([{
      id: 7, name: 'Hydrate', triggerString: '!hydrate', pointCost: 100, isEnabled: true, companionEnabled: true,
      params: [{ key: 'color', value: 'red' }],
    } as any]);
    const res = await supertest(app()).get('/commands').expect(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.body).toEqual({
      ok: true,
      commands: [{ id: 7, name: 'Hydrate', trigger: '!hydrate', pointCost: 100, isEnabled: true, companionEnabled: true, parameters: { color: 'red' } }],
    });
    expect(listAdvancedCommands).toHaveBeenCalledWith(3);
  });

  it('returns an empty list for a non-streamer', async () => {
    vi.mocked(getStreamerByDiscordId).mockResolvedValue(null);
    const res = await supertest(app()).get('/commands').expect(200);
    expect(res.body).toEqual({ ok: true, commands: [] });
  });

  it('returns 500 on a DB error', async () => {
    vi.mocked(getStreamerByDiscordId).mockRejectedValue(new Error('boom'));
    {
      const r = await supertest(app()).get('/commands');
      expect(r.status).toBe(500);
    }
  });
});

describe('POST /commands/ack', () => {
  it('passes a failure acknowledgement on, truncating the error text', async () => {
    const res = await supertest(app()).post('/commands/ack').send({ eventId: EVENT_ID, ok: false, error: 'x'.repeat(400) }).expect(200);
    expect(res.body).toEqual({ ok: true, resolved: true });
    const [, ack] = vi.mocked(acknowledgeAdvancedCommandUse).mock.calls[0]!;
    expect(ack.ok).toBe(false);
    expect(ack.error).toHaveLength(255);
  });

  it('passes a success acknowledgement on and reports an already-resolved use', async () => {
    vi.mocked(acknowledgeAdvancedCommandUse).mockResolvedValue(false);
    const res = await supertest(app()).post('/commands/ack').send({ eventId: EVENT_ID, ok: true }).expect(200);
    expect(res.body).toEqual({ ok: true, resolved: false });
    expect(acknowledgeAdvancedCommandUse).toHaveBeenCalledWith(EVENT_ID, { ok: true, error: null });
  });

  it.each([
    [{}],
    [{ eventId: 'not-a-uuid', ok: true }],
    [{ eventId: EVENT_ID, ok: 'yes' }],
    [{ eventId: EVENT_ID, ok: false, error: 42 }],
  ])('rejects a malformed body %o', async (body) => {
    {
      const r = await supertest(app()).post('/commands/ack').send(body);
      expect(r.status).toBe(400);
    }
    expect(acknowledgeAdvancedCommandUse).not.toHaveBeenCalled();
  });

  it('refuses another streamer\'s or an unknown event', async () => {
    vi.mocked(getAdvancedCommandUsageStreamerId).mockResolvedValueOnce(4);
    {
      const r = await supertest(app()).post('/commands/ack').send({ eventId: EVENT_ID, ok: true });
      expect(r.status).toBe(404);
    }
    vi.mocked(getAdvancedCommandUsageStreamerId).mockResolvedValueOnce(null);
    {
      const r = await supertest(app()).post('/commands/ack').send({ eventId: EVENT_ID, ok: true });
      expect(r.status).toBe(404);
    }
    vi.mocked(getStreamerByDiscordId).mockResolvedValueOnce(null);
    {
      const r = await supertest(app()).post('/commands/ack').send({ eventId: EVENT_ID, ok: true });
      expect(r.status).toBe(404);
    }
    expect(acknowledgeAdvancedCommandUse).not.toHaveBeenCalled();
  });

  it('returns 500 when acknowledging fails', async () => {
    vi.mocked(acknowledgeAdvancedCommandUse).mockRejectedValue(new Error('boom'));
    {
      const r = await supertest(app()).post('/commands/ack').send({ eventId: EVENT_ID, ok: true });
      expect(r.status).toBe(500);
    }
  });
});

describe('POST /commands/progress', () => {
  it('restarts the timeout for the streamer\'s own use', async () => {
    vi.mocked(extendAdvancedCommandAck).mockReturnValueOnce(true);
    const res = await supertest(app()).post('/commands/progress').send({ eventId: EVENT_ID }).expect(200);
    expect(res.body).toEqual({ ok: true, extended: true });
    expect(extendAdvancedCommandAck).toHaveBeenCalledWith(EVENT_ID);
  });

  it.each([[{}], [{ eventId: 'not-a-uuid' }], [{ eventId: 42 }]])('rejects a malformed body %o', async (body) => {
    {
      const r = await supertest(app()).post('/commands/progress').send(body);
      expect(r.status).toBe(400);
    }
    expect(extendAdvancedCommandAck).not.toHaveBeenCalled();
  });

  it('refuses another streamer\'s or an unknown event', async () => {
    vi.mocked(getAdvancedCommandUsageStreamerId).mockResolvedValueOnce(4);
    {
      const r = await supertest(app()).post('/commands/progress').send({ eventId: EVENT_ID });
      expect(r.status).toBe(404);
    }
    vi.mocked(getAdvancedCommandUsageStreamerId).mockResolvedValueOnce(null);
    {
      const r = await supertest(app()).post('/commands/progress').send({ eventId: EVENT_ID });
      expect(r.status).toBe(404);
    }
    expect(extendAdvancedCommandAck).not.toHaveBeenCalled();
  });

  it('returns 500 when the ownership lookup fails', async () => {
    vi.mocked(getAdvancedCommandUsageStreamerId).mockRejectedValueOnce(new Error('boom'));
    {
      const r = await supertest(app()).post('/commands/progress').send({ eventId: EVENT_ID });
      expect(r.status).toBe(500);
    }
  });
});
