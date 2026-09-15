import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { runUserMutation, runUserMutationForActorAndTarget, userMutationQueue } from './adminUserMutationQueue';

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

// Regression coverage for the actor-side TOCTOU: a guarded mutation whose operation re-reads the
// *acting* user's own current authorization must serialize against mutations for the actor's id
// too, not just the target's — see runUserMutationForActorAndTarget's doc comment.
describe('runUserMutationForActorAndTarget', () => {
  it('runs the operation through userMutationQueue, keyed by both actorId and targetId', async () => {
    const runSpy = vi.spyOn(userMutationQueue, 'run');
    const operation = vi.fn().mockResolvedValue('ok');

    const result = await runUserMutationForActorAndTarget('actor-1', 'target-1', operation);

    expect(result).toBe('ok');
    expect(runSpy).toHaveBeenCalledWith('actor-1', expect.any(Function));
    expect(runSpy).toHaveBeenCalledWith('target-1', expect.any(Function));
    expect(operation).toHaveBeenCalledOnce();
  });

  it('acquires the two ids\' queue slots in lexicographic order regardless of actor/target role', async () => {
    const runSpy = vi.spyOn(userMutationQueue, 'run');

    await runUserMutationForActorAndTarget('zzz-actor', 'aaa-target', vi.fn().mockResolvedValue(undefined));

    const [[firstKey], [secondKey]] = runSpy.mock.calls;
    expect(firstKey).toBe('aaa-target');
    expect(secondKey).toBe('zzz-actor');
  });

  it('collapses to a single queue slot when actorId equals targetId', async () => {
    const runSpy = vi.spyOn(userMutationQueue, 'run');

    await runUserMutationForActorAndTarget('same-id', 'same-id', vi.fn().mockResolvedValue(undefined));

    expect(runSpy).toHaveBeenCalledTimes(1);
    expect(runSpy).toHaveBeenCalledWith('same-id', expect.any(Function));
  });

  it('propagates the operation\'s own rejection', async () => {
    const boom = new Error('boom');
    await expect(runUserMutationForActorAndTarget('actor-1', 'target-1', () => Promise.reject(boom))).rejects.toBe(boom);
  });

  it('blocks the operation until a concurrent mutation already holding the actor\'s slot settles', async () => {
    let releaseActorMutation!: () => void;
    const actorMutation = runUserMutation('actor-2', () => new Promise<void>((resolve) => { releaseActorMutation = resolve; }));

    const operation = vi.fn().mockResolvedValue('done');
    const guarded = runUserMutationForActorAndTarget('actor-2', 'target-2', operation);

    await Promise.resolve();
    expect(operation).not.toHaveBeenCalled();

    releaseActorMutation();
    await actorMutation;
    expect(await guarded).toBe('done');
    expect(operation).toHaveBeenCalledOnce();
  });

  it('blocks the operation until a concurrent mutation already holding the target\'s slot settles', async () => {
    let releaseTargetMutation!: () => void;
    const targetMutation = runUserMutation('target-3', () => new Promise<void>((resolve) => { releaseTargetMutation = resolve; }));

    const operation = vi.fn().mockResolvedValue('done');
    const guarded = runUserMutationForActorAndTarget('actor-3', 'target-3', operation);

    await Promise.resolve();
    expect(operation).not.toHaveBeenCalled();

    releaseTargetMutation();
    await targetMutation;
    expect(await guarded).toBe('done');
  });
});
