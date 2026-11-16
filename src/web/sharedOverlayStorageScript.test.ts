import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import vm from 'vm';

const source = fs.readFileSync(path.join(__dirname, '../../public/shared-overlay-storage.js'), 'utf8');
const context: Record<string, any> = {};
vm.createContext(context);
vm.runInContext(`${source}\nthis.api = { idbTransactionDone, sharedStorageAvailable };`, context);
const { idbTransactionDone, sharedStorageAvailable } = context.api;

/** A fake IndexedDB transaction whose handlers the test fires by hand. */
function fakeTransaction(): Record<string, any> {
  return { oncomplete: null, onerror: null, onabort: null, error: null };
}

describe('idbTransactionDone', () => {
  it('resolves only when the transaction commits', async () => {
    const tx = fakeTransaction();
    let done = false;
    const waiting = idbTransactionDone(tx).then(() => { done = true; });
    await Promise.resolve();
    expect(done).toBe(false);
    tx.oncomplete();
    await waiting;
    expect(done).toBe(true);
  });

  it('rejects with the transaction error when it errors', async () => {
    const tx = fakeTransaction();
    const failure = new Error('quota');
    tx.error = failure;
    const waiting = idbTransactionDone(tx);
    tx.onerror();
    await expect(waiting).rejects.toBe(failure);
  });

  it('rejects when the transaction aborts while committing', async () => {
    const tx = fakeTransaction();
    const waiting = idbTransactionDone(tx);
    tx.onabort();
    await expect(waiting).rejects.toThrow('IndexedDB transaction aborted');
  });

  it('rejects with the abort reason when there is one', async () => {
    const tx = fakeTransaction();
    const reason = new Error('constraint');
    tx.error = reason;
    const waiting = idbTransactionDone(tx);
    tx.onabort();
    await expect(waiting).rejects.toBe(reason);
  });
});

describe('sharedStorageAvailable', () => {
  it('needs both Cache Storage and IndexedDB', () => {
    expect(sharedStorageAvailable()).toBe(false); // neither exists in this bare context
    vm.runInContext('this.caches = {}', context);
    expect(sharedStorageAvailable()).toBe(false);
    vm.runInContext('this.indexedDB = {}', context);
    expect(sharedStorageAvailable()).toBe(true);
  });
});
