import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'events';

const storage = vi.hoisted(() => ({ discardUpload: vi.fn(async () => {}) }));
vi.mock('./overlayUploadStorage', () => storage);

import { createUploadSlots } from './uploadSlots';

const BUSY = '/overlay/settings?error=upload_busy';

/** A response stub that can emit `close`, like a client leaving the page. */
function makeRes() {
  return Object.assign(new EventEmitter(), { redirect: vi.fn() });
}

/** A handler whose run stays pending until `finish` is called (or fails with `fail`). */
function makeHeldHandler() {
  let finish!: () => void;
  let fail!: (err: Error) => void;
  const handler = vi.fn(() => new Promise<void>((resolve, reject) => { finish = resolve; fail = reject; }));
  return { handler, finish: () => finish(), fail: (err: Error) => fail(err) };
}

beforeEach(() => vi.clearAllMocks());

describe('createUploadSlots', () => {
  it('turns an upload away with the busy redirect and removes its file once every slot is taken', async () => {
    const slots = createUploadSlots(2, BUSY);
    const held = [makeHeldHandler(), makeHeldHandler()];
    const running = held.map(({ handler }) => slots.admit(handler)({} as any, makeRes() as any));
    expect(slots.isFull()).toBe(true);

    const file = { filename: 'x.incoming' };
    const refused = makeRes();
    const turnedAway = vi.fn(async () => {});
    await slots.admit(turnedAway)({ file } as any, refused as any);
    expect(turnedAway).not.toHaveBeenCalled();
    expect(refused.redirect).toHaveBeenCalledWith(BUSY);
    expect(storage.discardUpload).toHaveBeenCalledWith(file);

    held.forEach(({ finish }) => finish());
    await Promise.all(running);
    expect(slots.isFull()).toBe(false);
  });

  it('keeps the slot while processing continues after the client disconnects', async () => {
    const slots = createUploadSlots(1, BUSY);
    const { handler, finish } = makeHeldHandler();
    const res = makeRes();
    const running = slots.admit(handler)({} as any, res as any);
    res.emit('close');
    expect(slots.isFull()).toBe(true);

    const second = makeRes();
    await slots.admit(vi.fn(async () => {}))({} as any, second as any);
    expect(second.redirect).toHaveBeenCalledWith(BUSY);

    finish();
    await running;
    const later = vi.fn(async () => {});
    await slots.admit(later)({} as any, makeRes() as any);
    expect(later).toHaveBeenCalledTimes(1);
  });

  it('frees the slot exactly once when the handler throws', async () => {
    const slots = createUploadSlots(1, BUSY);
    const { handler, fail } = makeHeldHandler();
    const running = slots.admit(handler)({} as any, makeRes() as any);
    fail(new Error('boom'));
    await expect(running).rejects.toThrow('boom');
    expect(slots.isFull()).toBe(false);

    // One slot, so two uploads in a row both being admitted shows it wasn't freed twice
    // (which would have let a second run alongside) or not at all.
    const first = makeHeldHandler();
    const firstRun = slots.admit(first.handler)({} as any, makeRes() as any);
    const refused = makeRes();
    await slots.admit(vi.fn(async () => {}))({} as any, refused as any);
    expect(refused.redirect).toHaveBeenCalledWith(BUSY);
    first.finish();
    await firstRun;
  });

  it('turns away an upload with no file without trying to remove one', async () => {
    const slots = createUploadSlots(0, BUSY);
    const res = makeRes();
    await slots.admit(vi.fn(async () => {}))({} as any, res as any);
    expect(res.redirect).toHaveBeenCalledWith(BUSY);
    expect(storage.discardUpload).not.toHaveBeenCalled();
  });
});
