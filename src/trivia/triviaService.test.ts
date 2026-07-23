import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mockLogger } from '../test-utils/loggerMock';

vi.mock('../shared/logger', () => ({ createLogger: mockLogger }));

const encode = (s: string): string => Buffer.from(s, 'utf-8').toString('base64');

function makeJsonResponse(body: unknown, ok = true, status = 200): Response {
  return { ok, status, json: async () => body } as unknown as Response;
}

function makeOpenTdbResult(question: string, correct = 'Right', incorrect = ['A', 'B', 'C']) {
  return {
    response_code: 0,
    results: [{
      category: encode('Category'),
      question: encode(question),
      correct_answer: encode(correct),
      incorrect_answers: incorrect.map(encode),
    }],
  };
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.resetModules();
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('fetchQuestion', () => {
  it('decodes base64 fields and shuffles all four answers into A-D', async () => {
    const { fetchQuestion } = await import('./triviaService.js');
    fetchMock.mockResolvedValueOnce(makeJsonResponse(makeOpenTdbResult('What is H2O?', 'Water', ['Fire', 'Salt', 'Sand'])));

    const result = await fetchQuestion(null);

    expect(result.category).toBe('Category');
    expect(result.question).toBe('What is H2O?');
    expect(result.choices.map((c: { letter: string }) => c.letter).sort()).toEqual(['A', 'B', 'C', 'D']);
    expect(new Set(result.choices.map((c: { text: string }) => c.text))).toEqual(new Set(['Water', 'Fire', 'Salt', 'Sand']));
    const correctChoice = result.choices.find((c) => c.letter === result.correctLetter);
    expect(correctChoice?.text).toBe('Water');
  });

  it('omits the token param when none is supplied', async () => {
    const { fetchQuestion } = await import('./triviaService.js');
    fetchMock.mockResolvedValueOnce(makeJsonResponse(makeOpenTdbResult('Q1')));
    await fetchQuestion(null);
    expect(fetchMock.mock.calls[0][0]).not.toContain('token=');
  });

  it('includes the token param when one is supplied', async () => {
    const { fetchQuestion } = await import('./triviaService.js');
    fetchMock.mockResolvedValueOnce(makeJsonResponse(makeOpenTdbResult('Q2')));
    await fetchQuestion('my-token');
    expect(fetchMock.mock.calls[0][0]).toContain('token=my-token');
  });

  it('resets the session token and retries once when the token is exhausted (response_code 4)', async () => {
    const { fetchQuestion } = await import('./triviaService.js');
    fetchMock
      .mockResolvedValueOnce(makeJsonResponse({ response_code: 4, results: [] }))
      .mockResolvedValueOnce(makeJsonResponse({ response_code: 0 }))
      .mockResolvedValueOnce(makeJsonResponse(makeOpenTdbResult('Q after reset')));

    const result = await fetchQuestion('exhausted-token');

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(fetchMock.mock.calls[1][0]).toContain('command=reset');
    expect(fetchMock.mock.calls[1][0]).toContain('exhausted-token');
    expect(result.question).toBe('Q after reset');
  });

  it('retries once after a rate-limit response_code (5), waiting out the backoff first', async () => {
    vi.useFakeTimers();
    try {
      const { fetchQuestion } = await import('./triviaService.js');
      fetchMock
        .mockResolvedValueOnce(makeJsonResponse({ response_code: 5, results: [] }))
        .mockResolvedValueOnce(makeJsonResponse(makeOpenTdbResult('Q after rate limit')));

      const promise = fetchQuestion(null);
      await vi.advanceTimersByTimeAsync(5000);
      const result = await promise;

      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(result.question).toBe('Q after rate limit');
    } finally {
      vi.useRealTimers();
    }
  });

  it('throws when OpenTDB returns an unrecoverable response_code', async () => {
    const { fetchQuestion } = await import('./triviaService.js');
    fetchMock.mockResolvedValueOnce(makeJsonResponse({ response_code: 2, results: [] }));
    await expect(fetchQuestion(null)).rejects.toThrow(/response_code 2/);
  });

  it('throws when the HTTP request itself fails', async () => {
    const { fetchQuestion } = await import('./triviaService.js');
    fetchMock.mockResolvedValueOnce(makeJsonResponse({}, false, 503));
    await expect(fetchQuestion(null)).rejects.toThrow(/HTTP 503/);
  });

  it('serializes concurrent requests with a minimum 5s gap between them', async () => {
    vi.useFakeTimers();
    try {
      const { fetchQuestion } = await import('./triviaService.js');
      fetchMock
        .mockResolvedValueOnce(makeJsonResponse(makeOpenTdbResult('first')))
        .mockResolvedValueOnce(makeJsonResponse(makeOpenTdbResult('second')));

      const p1 = fetchQuestion(null);
      await vi.advanceTimersByTimeAsync(0);
      expect(fetchMock).toHaveBeenCalledTimes(1);

      const p2 = fetchQuestion(null);
      await vi.advanceTimersByTimeAsync(0);
      expect(fetchMock).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(5000);
      expect(fetchMock).toHaveBeenCalledTimes(2);

      const [r1, r2] = await Promise.all([p1, p2]);
      expect(r1.question).toBe('first');
      expect(r2.question).toBe('second');
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('requestSessionToken', () => {
  it('returns the token on success', async () => {
    const { requestSessionToken } = await import('./triviaService.js');
    fetchMock.mockResolvedValueOnce(makeJsonResponse({ response_code: 0, token: 'abc123' }));
    await expect(requestSessionToken()).resolves.toBe('abc123');
  });

  it('throws when the response_code is non-zero', async () => {
    const { requestSessionToken } = await import('./triviaService.js');
    fetchMock.mockResolvedValueOnce(makeJsonResponse({ response_code: 2 }));
    await expect(requestSessionToken()).rejects.toThrow();
  });
});
