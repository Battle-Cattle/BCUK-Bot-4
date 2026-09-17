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
  it('runs the operation through userMutationQueue.runMany, keyed by both actorId and targetId', async () => {
    const runManySpy = vi.spyOn(userMutationQueue, 'runMany');
    const operation = vi.fn().mockResolvedValue('ok');

    const result = await runUserMutationForActorAndTarget('actor-1', 'target-1', operation);

    expect(result).toBe('ok');
    expect(runManySpy).toHaveBeenCalledWith(
      ['actor-1', 'target-1'],
      operation,
      15_000,
      'User mutation',
    );
    expect(operation).toHaveBeenCalledOnce();
  });

  it('acquires the two ids\' queue slots in lexicographic order regardless of actor/target role', async () => {
    const order: string[] = [];
    const releaseActor = userMutationQueue.run('aaa-target', () => new Promise<void>((resolve) => {
      order.push('aaa-target-start');
      resolve();
    }));
    await releaseActor;

    // aaa-target sorts before zzz-actor, so a concurrent mutation already queued for aaa-target
    // must be waited on before the guarded operation runs, regardless of which id is the actor.
    let releaseBlocker!: () => void;
    const blocker = userMutationQueue.run('aaa-target', () => new Promise<void>((resolve) => { releaseBlocker = resolve; }));

    const guarded = runUserMutationForActorAndTarget('zzz-actor', 'aaa-target', async () => {
      order.push('guarded');
    });

    await Promise.resolve();
    expect(order).not.toContain('guarded');

    releaseBlocker();
    await blocker;
    await guarded;
    expect(order).toEqual(['aaa-target-start', 'guarded']);
  });

  it('collapses to a single queue slot when actorId equals targetId', async () => {
    const runManySpy = vi.spyOn(userMutationQueue, 'runMany');
    const operation = vi.fn().mockResolvedValue(undefined);

    await runUserMutationForActorAndTarget('same-id', 'same-id', operation);

    expect(runManySpy).toHaveBeenCalledWith(['same-id', 'same-id'], operation, 15_000, 'User mutation');
    // runMany itself de-duplicates the key list, so only one slot is ever actually reserved.
    expect(userMutationQueue.size()).toBe(0);
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

  // Regression coverage for issue #659: nesting two single-key `run` calls released the first
  // slot only once the *nested* call for the second settled, so a backed-up queue for one id
  // delayed the other past USER_MUTATION_TIMEOUT_MS for every other pending mutation on it too.
  // `runMany`'s atomic acquisition must give up an already-held slot immediately once the whole
  // call times out, instead of holding it hostage for as long as the other slot's queue takes.
  it('releases an already-acquired slot immediately when the timeout elapses waiting on the other slot', async () => {
    let releaseTargetHolder!: () => void;
    const targetHolder = userMutationQueue.run('target-4', () => new Promise<void>((resolve) => { releaseTargetHolder = resolve; }));

    const operation = vi.fn().mockResolvedValue('done');
    // 'actor-4' sorts before 'target-4', so it's acquired immediately while 'target-4' stays
    // held by targetHolder for the whole 15s budget.
    const guarded = runUserMutationForActorAndTarget('actor-4', 'target-4', operation);
    const assertion = expect(guarded).rejects.toThrow('User mutation timed out after 15000ms');
    await vi.advanceTimersByTimeAsync(15_000);
    await assertion;
    expect(operation).not.toHaveBeenCalled();

    // actor-4's slot must already be free — a fresh mutation for it proceeds without waiting on
    // target-4's still-pending holder.
    expect(await runUserMutation('actor-4', async () => 'actor-free')).toBe('actor-free');

    releaseTargetHolder();
    await targetHolder;
  });
});
