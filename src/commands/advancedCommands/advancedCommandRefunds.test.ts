import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mockLogger } from '../../test-utils/loggerMock';

vi.mock('../../shared/logger', () => ({ createLogger: mockLogger }));
vi.mock('../../db', () => ({
  listPendingAdvancedCommandUsage: vi.fn(),
  resolveAdvancedCommandUsage: vi.fn(),
}));

import { listPendingAdvancedCommandUsage, resolveAdvancedCommandUsage } from '../../db';
import {
  ACK_TIMEOUT_MS, acknowledgeAdvancedCommandUse, clearAdvancedCommandAcks, refundAdvancedCommandUse,
  sweepPendingAdvancedCommandUsage, trackAdvancedCommandAck,
} from './advancedCommandRefunds';
import { registerAdvancedCommandRuntime } from './advancedCommandRuntime';
import { flushMicrotasks } from '../../test-utils/flushMicrotasks';

const send = vi.fn();
const RESOLVED = { streamerId: 3, commandName: 'Hydrate', twitchUsername: 'alice', pointsSpent: 100 };

beforeEach(() => {
  vi.clearAllMocks();
  send.mockResolvedValue(undefined);
  registerAdvancedCommandRuntime({ send, hasCompanionConnection: vi.fn() });
  vi.mocked(resolveAdvancedCommandUsage).mockResolvedValue(RESOLVED);
});

afterEach(() => {
  clearAdvancedCommandAcks();
  vi.useRealTimers();
});

describe('refundAdvancedCommandUse', () => {
  it('refunds through the ledger (which credits the points atomically) and tells the viewer', async () => {
    expect(await refundAdvancedCommandUse('e1', 'no_companion', { channel: 'streamer' })).toBe(true);
    expect(resolveAdvancedCommandUsage).toHaveBeenCalledWith('e1', { status: 'refunded', refundReason: 'no_companion', errorMessage: undefined });
    expect(send).toHaveBeenCalledWith('streamer', expect.stringContaining('@alice refunded 100 points for Hydrate'));
  });

  it('does nothing when the use was already resolved', async () => {
    vi.mocked(resolveAdvancedCommandUsage).mockResolvedValueOnce(null);
    expect(await refundAdvancedCommandUse('e1', 'no_ack', { channel: 'streamer' })).toBe(false);
    expect(send).not.toHaveBeenCalled();
  });

  it('sends no refund notice for a free or Stream Deck use', async () => {
    vi.mocked(resolveAdvancedCommandUsage).mockResolvedValueOnce({ ...RESOLVED, twitchUsername: null, pointsSpent: 0 });
    expect(await refundAdvancedCommandUse('e1', 'no_ack', { channel: 'streamer' })).toBe(true);
    expect(send).not.toHaveBeenCalled();
  });

  it('refunds without a chat notice when no channel is known, and survives a failed send', async () => {
    expect(await refundAdvancedCommandUse('e1', 'restart')).toBe(true);
    expect(send).not.toHaveBeenCalled();

    send.mockRejectedValueOnce(new Error('offline'));
    await expect(refundAdvancedCommandUse('e2', 'no_ack', { channel: 'streamer' })).resolves.toBe(true);
  });
});

describe('acknowledgements', () => {
  it('refunds when no acknowledgement arrives in time', async () => {
    vi.useFakeTimers();
    trackAdvancedCommandAck('e1', 'streamer');
    vi.advanceTimersByTime(ACK_TIMEOUT_MS);
    await flushMicrotasks();
    expect(resolveAdvancedCommandUsage).toHaveBeenCalledWith('e1', expect.objectContaining({ refundReason: 'no_ack' }));
  });

  it('logs (not throws) when the timeout refund fails, and retries it on the next timeout', async () => {
    vi.useFakeTimers();
    vi.mocked(resolveAdvancedCommandUsage).mockRejectedValueOnce(new Error('DB down'));
    trackAdvancedCommandAck('e1', 'streamer');
    vi.advanceTimersByTime(ACK_TIMEOUT_MS);
    await flushMicrotasks();
    expect(send).not.toHaveBeenCalled();

    vi.advanceTimersByTime(ACK_TIMEOUT_MS);
    await flushMicrotasks();
    expect(resolveAdvancedCommandUsage).toHaveBeenCalledTimes(2);
    expect(send).toHaveBeenCalledWith('streamer', expect.stringContaining('@alice refunded 100 points'));
  });

  it('re-arms the timeout when applying an acknowledgement fails, so the use still resolves', async () => {
    vi.useFakeTimers();
    vi.mocked(resolveAdvancedCommandUsage).mockRejectedValueOnce(new Error('DB down'));
    trackAdvancedCommandAck('e1', 'streamer');
    await expect(acknowledgeAdvancedCommandUse('e1', { ok: true })).rejects.toThrow('DB down');

    vi.advanceTimersByTime(ACK_TIMEOUT_MS);
    await flushMicrotasks();
    expect(resolveAdvancedCommandUsage).toHaveBeenLastCalledWith('e1', expect.objectContaining({ refundReason: 'no_ack' }));
  });

  it('rethrows a failed acknowledgement for an untracked use without arming a timer', async () => {
    vi.useFakeTimers();
    vi.mocked(resolveAdvancedCommandUsage).mockRejectedValueOnce(new Error('DB down'));
    await expect(acknowledgeAdvancedCommandUse('gone', { ok: false, error: 'x' })).rejects.toThrow('DB down');
    vi.advanceTimersByTime(ACK_TIMEOUT_MS);
    await flushMicrotasks();
    expect(resolveAdvancedCommandUsage).toHaveBeenCalledTimes(1);
  });

  it('marks a successful acknowledgement and cancels the timeout', async () => {
    vi.useFakeTimers();
    trackAdvancedCommandAck('e1', 'streamer');
    expect(await acknowledgeAdvancedCommandUse('e1', { ok: true })).toBe(true);
    vi.advanceTimersByTime(ACK_TIMEOUT_MS);
    await flushMicrotasks();
    expect(resolveAdvancedCommandUsage).toHaveBeenCalledExactlyOnceWith('e1', { status: 'succeeded' });
  });

  it('refunds on a failed acknowledgement, using the tracked channel and the error text', async () => {
    trackAdvancedCommandAck('e1', 'streamer');
    expect(await acknowledgeAdvancedCommandUse('e1', { ok: false, error: 'lamp offline' })).toBe(true);
    expect(resolveAdvancedCommandUsage).toHaveBeenCalledWith('e1', {
      status: 'refunded', refundReason: 'companion_error', errorMessage: 'lamp offline',
    });
    expect(send).toHaveBeenCalledWith('streamer', expect.stringContaining("couldn't run it"));
  });

  it('reports a duplicate or late acknowledgement as not resolving anything', async () => {
    vi.mocked(resolveAdvancedCommandUsage).mockResolvedValueOnce(null);
    expect(await acknowledgeAdvancedCommandUse('gone', { ok: true })).toBe(false);
  });
});

describe('sweepPendingAdvancedCommandUsage', () => {
  it('refunds every use left pending, skipping ones this process is still tracking', async () => {
    trackAdvancedCommandAck('live', 'streamer');
    vi.mocked(listPendingAdvancedCommandUsage).mockResolvedValue(['old1', 'live', 'old2']);
    vi.mocked(resolveAdvancedCommandUsage).mockResolvedValueOnce(RESOLVED).mockResolvedValueOnce(null);

    expect(await sweepPendingAdvancedCommandUsage()).toBe(1);
    expect(resolveAdvancedCommandUsage).toHaveBeenCalledTimes(2);
    expect(resolveAdvancedCommandUsage).not.toHaveBeenCalledWith('live', expect.anything());
  });

  it('keeps sweeping after one refund fails', async () => {
    vi.mocked(listPendingAdvancedCommandUsage).mockResolvedValue(['bad', 'good']);
    vi.mocked(resolveAdvancedCommandUsage).mockRejectedValueOnce(new Error('deadlock')).mockResolvedValueOnce(RESOLVED);

    expect(await sweepPendingAdvancedCommandUsage()).toBe(1);
    expect(resolveAdvancedCommandUsage).toHaveBeenCalledWith('good', expect.objectContaining({ refundReason: 'restart' }));
  });
});
