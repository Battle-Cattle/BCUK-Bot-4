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

  it('rejects with a timeout error, freeing the key, when the operation stalls', async () => {
    const result = runUserMutation('discord-1', () => new Promise(() => {}));
    const assertion = expect(result).rejects.toThrow('User mutation timed out after 15000ms');
    await vi.advanceTimersByTimeAsync(15_000);
    await assertion;

    // The key is freed even though the stalled operation never itself settled, so the next
    // mutation for the same discordId isn't wedged behind it.
    const next = await runUserMutation('discord-1', () => Promise.resolve('next'));
    expect(next).toBe('next');
  });
});
