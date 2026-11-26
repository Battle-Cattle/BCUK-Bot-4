import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../../db', () => ({
  createRafflePayouts: vi.fn(),
  payRafflePayout: vi.fn(),
  isRafflePayoutPaid: vi.fn(),
  recordStreamerEvent: vi.fn(),
  fitStreamerEventText: (displayName: string, detail: string | null) => ({ displayName, detail }),
}));

const { logErrorSpy, logWarnSpy, pushSpy } = vi.hoisted(() => ({ logErrorSpy: vi.fn(), logWarnSpy: vi.fn(), pushSpy: vi.fn() }));
vi.mock('../../shared/logger', () => ({ createLogger: () => ({ error: logErrorSpy, warn: logWarnSpy }) }));
// Vitest's fake timers don't replace node:timers/promises, so route the retry wait through the
// (faked) global setTimeout, keeping its abort-signal behaviour, so tests advance it instantly.
vi.mock('node:timers/promises', () => ({
  setTimeout: (ms: number, value: unknown, options?: { signal?: AbortSignal }) => new Promise((resolve, reject) => {
    const signal = options?.signal;
    if (signal?.aborted) { reject(signal.reason); return; }
    const timer = globalThis.setTimeout(() => resolve(value), ms);
    signal?.addEventListener('abort', () => { globalThis.clearTimeout(timer); reject(signal.reason); }, { once: true });
  }),
}));
vi.mock('../../twitch/eventsub/twitchEventSubRuntime', () => ({
  dashboardEventRuntimeRegistry: { get: () => ({ pushDashboardEvent: pushSpy }) },
}));

import { createRafflePayouts, isRafflePayoutPaid, payRafflePayout, recordStreamerEvent } from '../../db';
import { payRaffleWinners, RAFFLE_PAYOUT_RETRY_DELAYS_MS } from './rafflePayout';

const TOTAL_RETRY_MS = RAFFLE_PAYOUT_RETRY_DELAYS_MS.reduce((a, b) => a + b, 0);
const ATTEMPTS = RAFFLE_PAYOUT_RETRY_DELAYS_MS.length + 1;

/** A signal that never aborts. */
function liveSignal(): AbortSignal {
  return new AbortController().signal;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  vi.mocked(createRafflePayouts).mockImplementation(async (_raffleId, _streamerId, winners) =>
    winners.map((w) => ({ id: `id-${w}`, twitchUsername: w })));
  vi.mocked(payRafflePayout).mockResolvedValue('paid');
  vi.mocked(isRafflePayoutPaid).mockResolvedValue(false);
  vi.mocked(recordStreamerEvent).mockResolvedValue(1);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('payRaffleWinners', () => {
  it('does nothing when there are no winners', async () => {
    expect(await payRaffleWinners(7, [], 0, liveSignal())).toEqual({ paid: [], unpaid: [], unconfirmed: [] });
    expect(createRafflePayouts).not.toHaveBeenCalled();
  });

  it('records one ledger row per winner under a fresh draw id and pays each', async () => {
    const outcome = await payRaffleWinners(7, ['a', 'b'], 50, liveSignal());
    expect(outcome).toEqual({ paid: ['a', 'b'], unpaid: [], unconfirmed: [] });
    expect(createRafflePayouts).toHaveBeenCalledExactlyOnceWith(expect.stringMatching(/^[0-9a-f-]{36}$/), 7, ['a', 'b'], 50);
    expect(vi.mocked(payRafflePayout).mock.calls).toEqual([['id-a'], ['id-b']]);
    expect(recordStreamerEvent).not.toHaveBeenCalled();
  });

  it('counts a payout an earlier attempt already committed as paid', async () => {
    vi.mocked(payRafflePayout).mockResolvedValue('already_paid');
    expect(await payRaffleWinners(7, ['a'], 50, liveSignal())).toEqual({ paid: ['a'], unpaid: [], unconfirmed: [] });
  });

  it('retries a failed credit through the ledger and counts it paid once it succeeds', async () => {
    vi.mocked(payRafflePayout).mockRejectedValueOnce(new Error('queue full'));
    const pending = payRaffleWinners(7, ['a'], 50, liveSignal());
    await vi.advanceTimersByTimeAsync(RAFFLE_PAYOUT_RETRY_DELAYS_MS[0]!);
    expect(await pending).toEqual({ paid: ['a'], unpaid: [], unconfirmed: [] });
    expect(payRafflePayout).toHaveBeenCalledTimes(2);
    expect(logWarnSpy).toHaveBeenCalledWith(expect.stringContaining('retrying'), expect.any(Error));
  });

  it('gives up after the last retry, keeps the other winners paid and tells the streamer', async () => {
    vi.mocked(payRafflePayout).mockImplementation(async (id) => {
      if (id === 'id-b') throw new Error('db down');
      return 'paid';
    });
    const pending = payRaffleWinners(7, ['a', 'b', 'c'], 1500, liveSignal());
    await vi.advanceTimersByTimeAsync(TOTAL_RETRY_MS);
    expect(await pending).toEqual({ paid: ['a', 'c'], unpaid: ['b'], unconfirmed: [] });
    expect(vi.mocked(payRafflePayout).mock.calls.filter(([id]) => id === 'id-b')).toHaveLength(ATTEMPTS);
    expect(isRafflePayoutPaid).toHaveBeenCalledExactlyOnceWith('id-b');
    expect(logErrorSpy).toHaveBeenCalledWith(expect.stringContaining('Failed to pay raffle winner b'), expect.any(Error));
    expect(recordStreamerEvent).toHaveBeenCalledExactlyOnceWith(7, 'raffle_payout_failed', 'b', "1,500 points couldn't be added");
    expect(pushSpy).toHaveBeenCalledExactlyOnceWith(7, expect.objectContaining({
      id: 1, eventType: 'raffle_payout_failed', displayName: 'b', detail: "1,500 points couldn't be added",
    }));
  });

  it('counts a winner as paid when the last attempt failed but the ledger shows it committed', async () => {
    vi.mocked(payRafflePayout).mockRejectedValue(new Error('connection lost after COMMIT'));
    vi.mocked(isRafflePayoutPaid).mockResolvedValue(true);
    const pending = payRaffleWinners(7, ['a'], 50, liveSignal());
    await vi.advanceTimersByTimeAsync(TOTAL_RETRY_MS);
    expect(await pending).toEqual({ paid: ['a'], unpaid: [], unconfirmed: [] });
    expect(recordStreamerEvent).not.toHaveBeenCalled();
    expect(logWarnSpy).toHaveBeenCalledWith(expect.stringContaining('had committed'), expect.any(Error));
  });

  it('reports a winner as unconfirmed when the ledger cannot be read after the last attempt', async () => {
    vi.mocked(payRafflePayout).mockRejectedValue(new Error('db down'));
    vi.mocked(isRafflePayoutPaid).mockRejectedValue(new Error('still down'));
    const pending = payRaffleWinners(7, ['a'], 50, liveSignal());
    await vi.advanceTimersByTimeAsync(TOTAL_RETRY_MS);
    expect(await pending).toEqual({ paid: [], unpaid: [], unconfirmed: ['a'] });
    expect(recordStreamerEvent).toHaveBeenCalledExactlyOnceWith(7, 'raffle_payout_failed', 'a', '50 points may not have been added');
    expect(logErrorSpy).toHaveBeenCalledWith(expect.stringContaining("couldn't check"), expect.any(Error), expect.any(Error));
  });

  it('pays nobody, and reports every winner unpaid, when the ledger cannot be written', async () => {
    vi.mocked(createRafflePayouts).mockRejectedValue(new Error('db down'));
    expect(await payRaffleWinners(7, ['a', 'b'], 50, liveSignal())).toEqual({ paid: [], unpaid: ['a', 'b'], unconfirmed: [] });
    expect(payRafflePayout).not.toHaveBeenCalled();
    expect(recordStreamerEvent).toHaveBeenCalledTimes(2);
    expect(logErrorSpy).toHaveBeenCalledWith(expect.stringContaining('nobody was paid'), expect.any(Error));
  });

  it('starts no further attempt once the signal aborts during a retry wait, and settles from the ledger', async () => {
    const abort = new AbortController();
    vi.mocked(payRafflePayout).mockRejectedValue(new Error('pool closing'));
    const pending = payRaffleWinners(7, ['a'], 50, abort.signal);
    await vi.advanceTimersByTimeAsync(0);
    abort.abort();
    expect(await pending).toEqual({ paid: [], unpaid: ['a'], unconfirmed: [] });
    expect(payRafflePayout).toHaveBeenCalledOnce();
    expect(isRafflePayoutPaid).toHaveBeenCalledExactlyOnceWith('id-a');
  });

  it('makes no retry at all when the signal has already aborted', async () => {
    const abort = new AbortController();
    abort.abort();
    vi.mocked(payRafflePayout).mockRejectedValue(new Error('pool closing'));
    expect(await payRaffleWinners(7, ['a'], 50, abort.signal)).toEqual({ paid: [], unpaid: ['a'], unconfirmed: [] });
    expect(payRafflePayout).toHaveBeenCalledOnce();
  });

  it('still pushes the dashboard notice when it cannot be recorded', async () => {
    vi.mocked(createRafflePayouts).mockRejectedValue(new Error('db down'));
    vi.mocked(recordStreamerEvent).mockRejectedValue(new Error('still down'));
    expect(await payRaffleWinners(7, ['a'], 50, liveSignal())).toEqual({ paid: [], unpaid: ['a'], unconfirmed: [] });
    expect(logErrorSpy).toHaveBeenCalledWith('Failed to record unpaid raffle winner a for streamer 7:', expect.any(Error));
    expect(pushSpy).toHaveBeenCalledExactlyOnceWith(7, expect.objectContaining({ eventType: 'raffle_payout_failed', displayName: 'a' }));
    // No row id to send: the push carries none rather than an invented one.
    expect(pushSpy.mock.calls[0]![1]).not.toHaveProperty('id');
  });

  it('logs, rather than throwing, when the live dashboard push fails', async () => {
    vi.mocked(createRafflePayouts).mockRejectedValue(new Error('db down'));
    pushSpy.mockImplementationOnce(() => { throw new Error('sse broke'); });
    expect(await payRaffleWinners(7, ['a'], 50, liveSignal())).toEqual({ paid: [], unpaid: ['a'], unconfirmed: [] });
    expect(recordStreamerEvent).toHaveBeenCalledOnce();
    expect(logErrorSpy).toHaveBeenCalledWith("Failed to push unpaid raffle winner a to streamer 7's dashboard:", expect.any(Error));
  });
});
