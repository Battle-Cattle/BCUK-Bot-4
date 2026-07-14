import { describe, it, expect, vi } from 'vitest';
import { deferred } from './deferredPromise';

describe('deferred', () => {
  it('returns a promise that resolves with the value passed to resolve()', async () => {
    const { promise, resolve } = deferred<string>();
    resolve('done');
    await expect(promise).resolves.toBe('done');
  });

  it('returns a promise that rejects with the reason passed to reject()', async () => {
    const { promise, reject } = deferred();
    reject(new Error('failed'));
    await expect(promise).rejects.toThrow('failed');
  });

  it('does not settle until resolve or reject is called', async () => {
    const { promise, resolve } = deferred<number>();
    const onResolve = vi.fn();
    void promise.then(onResolve);
    await Promise.resolve();
    expect(onResolve).not.toHaveBeenCalled();
    resolve(42);
    await promise;
    expect(onResolve).toHaveBeenCalledWith(42);
  });

  it('defaults to void value type, resolvable with no argument', async () => {
    const { promise, resolve } = deferred();
    resolve();
    await expect(promise).resolves.toBeUndefined();
  });
});
