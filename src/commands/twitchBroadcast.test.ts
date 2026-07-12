import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../shared/logger', () => ({ createLogger: () => ({ info: vi.fn(), error: vi.fn() }) }));

import { sendDedupedBySession } from './twitchBroadcast';

describe('sendDedupedBySession', () => {
  let send: ReturnType<typeof vi.fn<(channel: string, message: string) => Promise<void>>>;
  let resolveSessionId: ReturnType<typeof vi.fn<(userId: string) => Promise<string | null>>>;

  beforeEach(() => {
    send = vi.fn().mockResolvedValue(undefined);
    resolveSessionId = vi.fn().mockResolvedValue(null);
  });

  it('sends to every target when none share a session', async () => {
    const loginUserIds = new Map([['#a', 'u1'], ['#b', 'u2']]);
    resolveSessionId.mockImplementation(async (uid: string) => `session-${uid}`);

    const result = await sendDedupedBySession(['#a', '#b'], loginUserIds, 'hello', send, resolveSessionId);

    expect(send).toHaveBeenCalledWith('#a', 'hello');
    expect(send).toHaveBeenCalledWith('#b', 'hello');
    expect(send).toHaveBeenCalledTimes(2);
    expect(result).toBe(true);
  });

  it('skips a later channel that shares a session with an earlier one', async () => {
    const loginUserIds = new Map([['#a', 'u1'], ['#b', 'u1']]);
    resolveSessionId.mockResolvedValue('shared-session');

    const result = await sendDedupedBySession(['#a', '#b'], loginUserIds, 'hi', send, resolveSessionId);

    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith('#a', 'hi');
    expect(result).toBe(true);
  });

  it('always sends to a channel absent from loginUserIds (no session to dedupe against)', async () => {
    const loginUserIds = new Map<string, string>();

    const result = await sendDedupedBySession(['#a', '#b'], loginUserIds, 'hi', send, resolveSessionId);

    expect(send).toHaveBeenCalledTimes(2);
    expect(result).toBe(true);
  });

  it('resolves each unique user id session only once, in parallel', async () => {
    const loginUserIds = new Map([['#a', 'u1'], ['#b', 'u1'], ['#c', 'u2']]);
    resolveSessionId.mockImplementation(async (uid: string) => `session-${uid}`);

    await sendDedupedBySession(['#a', '#b', '#c'], loginUserIds, 'hi', send, resolveSessionId);

    expect(resolveSessionId).toHaveBeenCalledTimes(2);
    expect(resolveSessionId).toHaveBeenCalledWith('u1');
    expect(resolveSessionId).toHaveBeenCalledWith('u2');
  });

  it('logs and continues when a send fails for one channel', async () => {
    const loginUserIds = new Map([['#a', 'u1'], ['#b', 'u2']]);
    send.mockRejectedValueOnce(new Error('network blip'));

    const result = await sendDedupedBySession(['#a', '#b'], loginUserIds, 'hi', send, resolveSessionId);

    expect(send).toHaveBeenCalledTimes(2);
    // '#a' failed, but '#b' still succeeded, so overall result is true.
    expect(result).toBe(true);
  });

  it('returns false when every send fails', async () => {
    const loginUserIds = new Map([['#a', 'u1']]);
    send.mockRejectedValue(new Error('down'));

    const result = await sendDedupedBySession(['#a'], loginUserIds, 'hi', send, resolveSessionId);

    expect(result).toBe(false);
  });

  it('returns false for an empty target list', async () => {
    const result = await sendDedupedBySession([], new Map(), 'hi', send, resolveSessionId);

    expect(send).not.toHaveBeenCalled();
    expect(result).toBe(false);
  });

  it('treats a rejected session lookup as no session, sending anyway, instead of aborting all sends', async () => {
    const loginUserIds = new Map([['#a', 'u1'], ['#b', 'u2']]);
    resolveSessionId.mockImplementation(async (uid: string) => {
      if (uid === 'u1') throw new Error('Helix lookup failed');
      return `session-${uid}`;
    });

    const result = await sendDedupedBySession(['#a', '#b'], loginUserIds, 'hi', send, resolveSessionId);

    expect(send).toHaveBeenCalledWith('#a', 'hi');
    expect(send).toHaveBeenCalledWith('#b', 'hi');
    expect(send).toHaveBeenCalledTimes(2);
    expect(result).toBe(true);
  });

  it('does not mark a session as replied when the first channel in it fails to send', async () => {
    const loginUserIds = new Map([['#a', 'u1'], ['#b', 'u1']]);
    resolveSessionId.mockResolvedValue('shared-session');
    send.mockRejectedValueOnce(new Error('boom'));

    const result = await sendDedupedBySession(['#a', '#b'], loginUserIds, 'hi', send, resolveSessionId);

    // '#a' failed so the session was never marked replied — '#b' (same session) is still attempted.
    expect(send).toHaveBeenCalledTimes(2);
    expect(send).toHaveBeenCalledWith('#b', 'hi');
    expect(result).toBe(true);
  });
});
