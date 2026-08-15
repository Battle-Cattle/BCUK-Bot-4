import { describe, it, expect, vi, afterEach } from 'vitest';
import { fetchWithRetry } from './fetchWithRetry';

function mockLog() {
  const warn = vi.fn();
  return { log: { warn } as unknown as import('winston').Logger, warn };
}

function mockResponses(responses: { ok: boolean; status?: number }[]) {
  let callIndex = 0;
  return vi.spyOn(globalThis, 'fetch').mockImplementation(() => {
    const r = responses[callIndex++];
    return Promise.resolve({ ok: r.ok, status: r.status ?? 200 } as Response);
  });
}

describe('fetchWithRetry', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns the response immediately when it is ok, without retrying', async () => {
    const fetchSpy = mockResponses([{ ok: true, status: 200 }]);
    const { log, warn } = mockLog();

    const res = await fetchWithRetry('https://example.com', {}, log);

    expect(res.ok).toBe(true);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(warn).not.toHaveBeenCalled();
  });

  it('does not retry a non-transient error status', async () => {
    const fetchSpy = mockResponses([{ ok: false, status: 400 }]);
    const { log, warn } = mockLog();

    const res = await fetchWithRetry('https://example.com', {}, log);

    expect(res.ok).toBe(false);
    expect(res.status).toBe(400);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(warn).not.toHaveBeenCalled();
  });

  it('retries a transient 503 and returns the successful response', async () => {
    const fetchSpy = mockResponses([{ ok: false, status: 503 }, { ok: true, status: 200 }]);
    const { log, warn } = mockLog();

    const res = await fetchWithRetry('https://example.com', {}, log, 2, 1);

    expect(res.ok).toBe(true);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('gives up and returns the last response after exhausting retries', async () => {
    const fetchSpy = mockResponses([{ ok: false, status: 503 }, { ok: false, status: 503 }, { ok: false, status: 503 }]);
    const { log, warn } = mockLog();

    const res = await fetchWithRetry('https://example.com', {}, log, 2, 1);

    expect(res.ok).toBe(false);
    expect(res.status).toBe(503);
    expect(fetchSpy).toHaveBeenCalledTimes(3);
    expect(warn).toHaveBeenCalledTimes(2);
  });
});
