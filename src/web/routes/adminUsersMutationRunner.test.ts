import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockLog } = vi.hoisted(() => ({ mockLog: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));
vi.mock('../../shared/logger', () => ({ createLogger: () => mockLog }));
// adminUserAuth (for ManagerEditAuthError) imports the DB facade; the class itself needs no DB.
vi.mock('../../db', () => ({}));
vi.mock('../../discord/guildRegistry', () => ({ reloadGuildRegistry: vi.fn() }));
vi.mock('../../shared/userMutationQueue', () => ({
  runUserMutationForActorAndTarget: vi.fn((_actor: string, _target: string, op: () => Promise<void>) => op()),
}));

import { reloadGuildRegistry } from '../../discord/guildRegistry';
import { runUserMutationForActorAndTarget } from '../../shared/userMutationQueue';
import { ManagerEditAuthError } from './adminUserAuth';
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
  it('runs the operation in the queue for both ids and redirects to /admin/users', async () => {
    const res = mockRes();
    const op = vi.fn().mockResolvedValue(undefined);
    await runGuardedUserMutation(res, 'actor', 'target', op, vi.fn());
    expect(runUserMutationForActorAndTarget).toHaveBeenCalledWith('actor', 'target', op);
    expect(res.redirect).toHaveBeenCalledWith('/admin/users');
  });

  it('redirects with the code of a ManagerEditAuthError', async () => {
    const res = mockRes();
    const onOtherError = vi.fn();
    await runGuardedUserMutation(res, 'a', 't', () => Promise.reject(new ManagerEditAuthError('not_found')), onOtherError);
    expect(res.redirect).toHaveBeenCalledWith('/admin/users?error=not_found');
    expect(onOtherError).not.toHaveBeenCalled();
  });

  it('hands any other error to onOtherError', async () => {
    const res = mockRes();
    const onOtherError = vi.fn();
    const err = new Error('db');
    await runGuardedUserMutation(res, 'a', 't', () => Promise.reject(err), onOtherError);
    expect(onOtherError).toHaveBeenCalledWith(err);
    expect(res.redirect).not.toHaveBeenCalled();
  });
});
