import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../../db', () => ({
  createRafflePayouts: vi.fn(),
  payRafflePayout: vi.fn(),
  recordStreamerEvent: vi.fn(),
  fitStreamerEventText: (displayName: string, detail: string | null) => ({ displayName, detail }),
}));

const { logErrorSpy, logWarnSpy, pushSpy } = vi.hoisted(() => ({ logErrorSpy: vi.fn(), logWarnSpy: vi.fn(), pushSpy: vi.fn() }));
vi.mock('../../shared/logger', () => ({ createLogger: () => ({ error: logErrorSpy, warn: logWarnSpy }) }));
vi.mock('../../twitch/eventsub/twitchEventSubRuntime', () => ({
  dashboardEventRuntimeRegistry: { get: () => ({ pushDashboardEvent: pushSpy }) },
}));

import { createRafflePayouts, payRafflePayout, recordStreamerEvent } from '../../db';
import { payRaffleWinners, RAFFLE_PAYOUT_RETRY_DELAYS_MS } from './rafflePayout';

const TOTAL_RETRY_MS = RAFFLE_PAYOUT_RETRY_DELAYS_MS.reduce((a, b) => a + b, 0);

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  vi.mocked(createRafflePayouts).mockImplementation(async (_raffleId, _streamerId, winners) =>
    winners.map((w) => ({ id: `id-${w}`, twitchUsername: w })));
  vi.mocked(payRafflePayout).mockResolvedValue('paid');
  vi.mocked(recordStreamerEvent).mockResolvedValue(1);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('payRaffleWinners', () => {
  it('does nothing when there are no winners', async () => {
    expect(await payRaffleWinners(7, [], 0, new AbortController().signal)).toEqual({ paid: [], unpaid: [] });
    expect(createRafflePayouts).not.toHaveBeenCalled();
  });

  it('records one ledger row per winner under a fresh draw id and pays each', async () => {
    const outcome = await payRaffleWinners(7, ['a', 'b'], 50, new AbortController().signal);
    expect(outcome).toEqual({ paid: ['a', 'b'], unpaid: [] });
    expect(createRafflePayouts).toHaveBeenCalledExactlyOnceWith(expect.stringMatching(/^[0-9a-f-]{36}$/), 7, ['a', 'b'], 50);
    expect(vi.mocked(payRafflePayout).mock.calls).toEqual([['id-a'], ['id-b']]);
    expect(recordStreamerEvent).not.toHaveBeenCalled();
  });

  it('counts a payout an earlier attempt already committed as paid', async () => {
    vi.mocked(payRafflePayout).mockResolvedValue('already_paid');
    expect(await payRaffleWinners(7, ['a'], 50, new AbortController().signal)).toEqual({ paid: ['a'], unpaid: [] });
  });

  it('retries a failed credit through the ledger and counts it paid once it succeeds', async () => {
    vi.mocked(payRafflePayout).mockRejectedValueOnce(new Error('queue full'));
    const pending = payRaffleWinners(7, ['a'], 50, new AbortController().signal);
    await vi.advanceTimersByTimeAsync(RAFFLE_PAYOUT_RETRY_DELAYS_MS[0]!);
    expect(await pending).toEqual({ paid: ['a'], unpaid: [] });
    expect(payRafflePayout).toHaveBeenCalledTimes(2);
    expect(logWarnSpy).toHaveBeenCalledWith(expect.stringContaining('retrying'), expect.any(Error));
  });

  it('gives up after the last retry, keeps the other winners paid and tells the streamer', async () => {
    vi.mocked(payRafflePayout).mockImplementation(async (id) => {
      if (id === 'id-b') throw new Error('db down');
      return 'paid';
    });
    const pending = payRaffleWinners(7, ['a', 'b', 'c'], 1500, new AbortController().signal);
    await vi.advanceTimersByTimeAsync(TOTAL_RETRY_MS);
    expect(await pending).toEqual({ paid: ['a', 'c'], unpaid: ['b'] });
    expect(vi.mocked(payRafflePayout).mock.calls.filter(([id]) => id === 'id-b')).toHaveLength(RAFFLE_PAYOUT_RETRY_DELAYS_MS.length + 1);
    expect(logErrorSpy).toHaveBeenCalledWith(expect.stringContaining('Failed to pay raffle winner b'), expect.any(Error));
    expect(recordStreamerEvent).toHaveBeenCalledExactlyOnceWith(7, 'raffle_payout_failed', 'b', "1,500 points couldn't be added");
    expect(pushSpy).toHaveBeenCalledExactlyOnceWith(7, expect.objectContaining({
      eventType: 'raffle_payout_failed', displayName: 'b', detail: "1,500 points couldn't be added",
    }));
  });

  it('pays nobody, and reports every winner unpaid, when the ledger cannot be written', async () => {
    vi.mocked(createRafflePayouts).mockRejectedValue(new Error('db down'));
    expect(await payRaffleWinners(7, ['a', 'b'], 50, new AbortController().signal)).toEqual({ paid: [], unpaid: ['a', 'b'] });
    expect(payRafflePayout).not.toHaveBeenCalled();
    expect(recordStreamerEvent).toHaveBeenCalledTimes(2);
    expect(logErrorSpy).toHaveBeenCalledWith(expect.stringContaining('nobody was paid'), expect.any(Error));
  });

  it('skips the remaining retries once the signal aborts', async () => {
    const abort = new AbortController();
    vi.mocked(payRafflePayout).mockRejectedValue(new Error('pool closing'));
    const pending = payRaffleWinners(7, ['a'], 50, abort.signal);
    await vi.advanceTimersByTimeAsync(0);
    abort.abort();
    expect(await pending).toEqual({ paid: [], unpaid: ['a'] });
    // The first attempt, then the one the aborted wait falls through to; no further retries.
    expect(payRafflePayout).toHaveBeenCalledTimes(2);
  });

  it('logs, rather than throwing, when the dashboard notice cannot be recorded', async () => {
    vi.mocked(createRafflePayouts).mockRejectedValue(new Error('db down'));
    vi.mocked(recordStreamerEvent).mockRejectedValue(new Error('still down'));
    expect(await payRaffleWinners(7, ['a'], 50, new AbortController().signal)).toEqual({ paid: [], unpaid: ['a'] });
    expect(logErrorSpy).toHaveBeenCalledWith('Failed to record unpaid raffle winner a for streamer 7:', expect.any(Error));
    expect(pushSpy).not.toHaveBeenCalled();
  });
});
