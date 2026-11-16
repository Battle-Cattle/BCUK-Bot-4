import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockLog } = vi.hoisted(() => ({ mockLog: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));
vi.mock('../../shared/logger', () => ({ createLogger: () => mockLog }));
vi.mock('../../discord/guildRegistry', () => ({ reloadGuildRegistry: vi.fn() }));
vi.mock('../../shared/userMutationQueue', () => ({
  runUserMutationForActorAndTarget: vi.fn((_actor: string, _target: string, op: () => Promise<unknown>) => op()),
}));

import { reloadGuildRegistry } from '../../discord/guildRegistry';
import { runUserMutationForActorAndTarget } from '../../shared/userMutationQueue';
import { reloadRegistrySafe, runGuardedUserMutation } from './adminUsersMutationRunner';

const mockRes = () => ({ redirect: vi.fn() }) as any;

beforeEach(() => { vi.clearAllMocks(); });

describe('reloadRegistrySafe', () => {
  it('reloads the guild registry', async () => {
    vi.mocked(reloadGuildRegistry).mockResolvedValue(undefined);
    await reloadRegistrySafe();
    expect(reloadGuildRegistry).toHaveBeenCalledTimes(1);
  });

  it('logs a reload failure instead of throwing', async () => {
    vi.mocked(reloadGuildRegistry).mockRejectedValue(new Error('boom'));
    await expect(reloadRegistrySafe()).resolves.toBeUndefined();
    expect(mockLog.error).toHaveBeenCalled();
  });
});

describe('runGuardedUserMutation', () => {
  it('authorizes, then writes, inside one queue slot for both ids, then redirects to /admin/users', async () => {
    const res = mockRes();
    const order: string[] = [];
    vi.mocked(runUserMutationForActorAndTarget).mockImplementationOnce(async (_a, _t, op) => {
      order.push('enter queue');
      return op();
    });
    await runGuardedUserMutation(res, 'actor', 'target', {
      authorize: async () => { order.push('authorize'); return null; },
      write: async () => { order.push('write'); },
      onError: vi.fn(),
    });
    expect(runUserMutationForActorAndTarget).toHaveBeenCalledWith('actor', 'target', expect.any(Function));
    expect(order).toEqual(['enter queue', 'authorize', 'write']);
    expect(res.redirect).toHaveBeenCalledWith('/admin/users');
  });

  it('skips the write and redirects with the code when authorization fails', async () => {
    const res = mockRes();
    const write = vi.fn();
    await runGuardedUserMutation(res, 'a', 't', { authorize: async () => 'target_above_level', write, onError: vi.fn() });
    expect(write).not.toHaveBeenCalled();
    expect(res.redirect).toHaveBeenCalledWith('/admin/users?error=target_above_level');
  });

  it('redirects with a code the write returns', async () => {
    const res = mockRes();
    await runGuardedUserMutation(res, 'a', 't', { authorize: async () => null, write: async () => 'not_found', onError: vi.fn() });
    expect(res.redirect).toHaveBeenCalledWith('/admin/users?error=not_found');
  });

  it.each([
    ['authorize', { authorize: () => Promise.reject(new Error('db')), write: async () => null }],
    ['write', { authorize: async () => null, write: () => Promise.reject(new Error('db')) }],
  ])('hands an error thrown by %s to onError without redirecting', async (_step, steps) => {
    const res = mockRes();
    const onError = vi.fn();
    await runGuardedUserMutation(res, 'a', 't', { ...steps, onError });
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: 'db' }));
    expect(res.redirect).not.toHaveBeenCalled();
  });
});
