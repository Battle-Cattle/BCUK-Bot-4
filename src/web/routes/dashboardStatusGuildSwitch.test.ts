import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../shared/config', () => ({
  DASHBOARD_STATUS_MAX_SSE_PER_GUILD: 5,
  SSE_MAX_TOTAL_CONNECTIONS: 1000,
}));
vi.mock('../../shared/statusStore', () => ({ onStatusChanged: vi.fn() }));
vi.mock('../guildScopedStatus', () => ({ getGuildScopedStatus: vi.fn() }));
vi.mock('../../db', () => ({ findUser: vi.fn(), getMemberAccessLevel: vi.fn() }));
vi.mock('../middleware', () => ({
  requireGuildContext: (_req: any, _res: any, next: any) => next(),
}));
vi.mock('../../shared/logger', () => ({ createLogger: () => ({ error: vi.fn(), warn: vi.fn(), info: vi.fn() }) }));

// The real session-stream registry and the real status route: a stream opened under one guild, then the session picks another.
import { EventEmitter } from 'events';
import router, { connections } from './dashboardStatusEvents';
import { findUser, getMemberAccessLevel } from '../../db';
import { onStatusChanged } from '../../shared/statusStore';
import { getGuildScopedStatus } from '../guildScopedStatus';
import { switchSessionGuild, closeSessionStreamsForGuild, resetSessionStreamsForTests } from '../sessionStreams';

const registeredListener = vi.mocked(onStatusChanged).mock.calls[0]?.[0] as (guildId: string | null) => Promise<void>;

/** The status route's handler, taken from the router's stack so the request and response can be stand-ins. */
function statusHandler(): (req: any, res: any, next: any) => Promise<void> {
  const layer = (router as any).stack.find((l: any) => l.route?.path === '/status/events');
  return layer.route.stack.at(-1).handle;
}

/** An open-ended SSE response stand-in whose `end()` closes it, as a real one does. */
function makeRes() {
  const res: any = new EventEmitter();
  Object.assign(res, {
    closed: false, writableLength: 0, setHeader: vi.fn(), flushHeaders: vi.fn(), write: vi.fn(), status: vi.fn().mockReturnThis(),
    end: vi.fn(() => { res.emit('close'); }),
  });
  return res;
}

/** A request for session `sessionID` whose current guild is `guildId`. */
function makeReq(sessionID: string, guildId: string) {
  const req: any = new EventEmitter();
  Object.assign(req, { destroyed: false, sessionID, session: { user: { discordId: 'discord1', currentGuildId: guildId } } });
  return req;
}

/** Every `data:` frame written to a response, parsed. */
function frames(res: any): unknown[] {
  return res.write.mock.calls
    .map(([chunk]: [string]) => chunk)
    .filter((chunk: string) => chunk.startsWith('data: '))
    .map((chunk: string) => JSON.parse(chunk.slice(6)));
}

beforeEach(() => {
  vi.clearAllMocks();
  connections.clear();
  resetSessionStreamsForTests();
  vi.mocked(findUser).mockResolvedValue({ discord_id: 'discord1', is_owner: true } as any);
  vi.mocked(getMemberAccessLevel).mockResolvedValue(0 as any);
  vi.mocked(getGuildScopedStatus).mockImplementation(async (guildId: any) => ({ guildId }) as any);
});

describe('the status stream when its session switches guild (#1116)', () => {
  it('closes the stream opened under guild X, so guild Y\'s channels never reach it, and keeps a stream opened under Y', async () => {
    const handler = statusHandler();
    const underX = makeRes();
    const underY = makeRes();
    await handler(makeReq('sid-1', 'guild-X'), underX, vi.fn());
    await handler(makeReq('sid-2', 'guild-Y'), underY, vi.fn());
    expect(connections.get('guild-X')?.has(underX)).toBe(true);

    switchSessionGuild('sid-1', 'guild-Y');
    await registeredListener('guild-Y');
    await registeredListener('guild-X');

    expect(underX.end).toHaveBeenCalledTimes(1);
    expect(connections.get('guild-X')).toBeUndefined();
    expect(frames(underX)).toEqual([]); // nothing from either guild, before or after the switch
    expect(frames(underY)).toEqual([{ guildId: 'guild-Y' }]);
    expect(underY.end).not.toHaveBeenCalled();
  });

  it('refuses a stream whose request loaded the old guild before the switch and attaches after it, without its access re-check', async () => {
    const handler = statusHandler();
    switchSessionGuild('sid-1', 'guild-Y');
    const late = makeRes();

    await handler(makeReq('sid-1', 'guild-X'), late, vi.fn());

    expect(late.end).toHaveBeenCalledTimes(1);
    expect(findUser).not.toHaveBeenCalled();
    await registeredListener('guild-X');
    expect(frames(late)).toEqual([]);
  });

  it('leaves the session\'s stream open when it picks the guild it is already in', async () => {
    const handler = statusHandler();
    const res = makeRes();
    await handler(makeReq('sid-1', 'guild-X'), res, vi.fn());

    switchSessionGuild('sid-1', 'guild-X');

    expect(res.end).not.toHaveBeenCalled();
    res.emit('close');
  });
});

describe('the status stream when its session loses a guild (#1116)', () => {
  it('closes the session\'s streams for the lost guild, and a stream racing the revoke is ended by the post-attach re-check without a frame', async () => {
    const handler = statusHandler();
    const open = makeRes();
    await handler(makeReq('sid-1', 'guild-X'), open, vi.fn());

    closeSessionStreamsForGuild('sid-1', 'guild-X'); // requireGuildContext dropped guild-X for this session
    vi.mocked(findUser).mockResolvedValue({ discord_id: 'discord1', is_owner: false } as any);
    vi.mocked(getMemberAccessLevel).mockResolvedValue(null); // the membership is gone
    const racing = makeRes();
    await handler(makeReq('sid-1', 'guild-X'), racing, vi.fn());
    await registeredListener('guild-X');

    expect(open.end).toHaveBeenCalledTimes(1);
    expect(racing.end).toHaveBeenCalledTimes(1);
    expect(frames(open)).toEqual([]);
    expect(frames(racing)).toEqual([]);
    expect(connections.get('guild-X')).toBeUndefined();
  });

  it('accepts a stream for the guild the user is auto-picked into after losing the previous one', async () => {
    const handler = statusHandler();
    switchSessionGuild('sid-1', 'guild-X');
    closeSessionStreamsForGuild('sid-1', 'guild-X');
    const res = makeRes();

    await handler(makeReq('sid-1', 'guild-Y'), res, vi.fn());
    await registeredListener('guild-Y');

    expect(res.end).not.toHaveBeenCalled();
    expect(frames(res)).toEqual([{ guildId: 'guild-Y' }]);
    res.emit('close');
  });
});
