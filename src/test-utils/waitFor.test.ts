import { describe, it, expect, vi, afterEach } from 'vitest';
import { waitFor, WAIT_FOR_INTERVAL_MS } from './waitFor';

describe('waitFor', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('resolves with the callback result once it stops throwing', async () => {
    let calls = 0;
    const result = await waitFor(() => {
      calls++;
      if (calls < 3) throw new Error('not yet');
      return 'done';
    });
    expect(result).toBe('done');
    expect(calls).toBe(3);
  });

  it('polls at WAIT_FOR_INTERVAL_MS by default', async () => {
    const spy = vi.spyOn(vi, 'waitFor');
    await waitFor(() => true);
    expect(spy).toHaveBeenCalledWith(expect.any(Function), { interval: WAIT_FOR_INTERVAL_MS });
  });

  it('lets the caller override the interval and timeout', async () => {
    const spy = vi.spyOn(vi, 'waitFor');
    await waitFor(() => true, { interval: 5, timeout: 200 });
    expect(spy).toHaveBeenCalledWith(expect.any(Function), { interval: 5, timeout: 200 });
  });

  it('rejects with the last error when the timeout elapses', async () => {
    await expect(waitFor(() => { throw new Error('never'); }, { timeout: 20 })).rejects.toThrow('never');
  });
});
