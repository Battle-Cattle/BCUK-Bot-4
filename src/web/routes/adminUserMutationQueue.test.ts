import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { runUserMutation, userMutationQueue } from './adminUserMutationQueue';

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('runUserMutation', () => {
  it('runs the operation through userMutationQueue, keyed by discordId', async () => {
    const runSpy = vi.spyOn(userMutationQueue, 'run');
    const operation = vi.fn().mockResolvedValue('ok');

    const result = await runUserMutation('discord-1', operation);

    expect(result).toBe('ok');
    expect(runSpy).toHaveBeenCalledWith('discord-1', expect.any(Function));
    expect(operation).toHaveBeenCalledOnce();
  });

  it('propagates the operation\'s own rejection', async () => {
    const boom = new Error('boom');
    await expect(runUserMutation('discord-1', () => Promise.reject(boom))).rejects.toBe(boom);
  });

  it('rejects the caller with a timeout error when the operation stalls, without abandoning it', async () => {
    let settleStalled!: (value: string) => void;
    const stalled = new Promise<string>((resolve) => { settleStalled = resolve; });
    const result = runUserMutation('discord-1', () => stalled);
    const assertion = expect(result).rejects.toThrow('User mutation timed out after 15000ms');
    await vi.advanceTimersByTimeAsync(15_000);
    await assertion;

    // The queue key for this discordId is NOT freed at the timeout — a second mutation queued
    // behind the still-running stalled one must wait for it to genuinely finish, so it can never
    // run concurrently with (and race) the abandoned operation's eventual side effects.
    const next = runUserMutation('discord-1', () => Promise.resolve('next'));
    await vi.advanceTimersByTimeAsync(1_000);
    const order: string[] = [];
    void next.then(() => order.push('next'));
    await Promise.resolve();
    expect(order).toEqual([]); // still waiting on the stalled operation

    settleStalled('stalled result');
    expect(await next).toBe('next');
  });
});
