import { describe, it, expect } from 'vitest';
import { flushMicrotasks } from './flushMicrotasks';

describe('flushMicrotasks', () => {
  it('resolves once all pending microtasks have settled', async () => {
    let settled = false;
    void Promise.resolve().then(() => Promise.resolve()).then(() => { settled = true; });
    await flushMicrotasks();
    expect(settled).toBe(true);
  });

  it('resolves immediately when there is nothing pending', async () => {
    await expect(flushMicrotasks()).resolves.toBeUndefined();
  });
});
