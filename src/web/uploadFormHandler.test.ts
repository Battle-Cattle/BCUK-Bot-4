import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import vm from 'vm';
import { createHash } from 'crypto';

// utils.js plus the chunked uploader's scripts, as the upload pages load them.
const utilsSource = ['utils.js', 'chunkedUpload.js', 'chunkedUploadResume.js']
  .map((name) => fs.readFileSync(path.join(__dirname, '../../public', name), 'utf8'))
  .join('\n');
const BASE = '/overlay/settings/videos/upload';
const ID = '0f8fad5b-d9cb-469f-a165-70867728950e';
const PROGRESS_ID = 'ab'.repeat(16);
const DONE_URL = '/overlay/settings?success=video_uploaded';
const PROGRESS_URL = '/overlay/settings/videos/progress/';

type Listener = (event?: any) => void;

/** Minimal event target: records listeners by type and fires them. */
class FakeTarget {
  listeners: Record<string, Listener[]> = {};
  addEventListener(type: string, listener: Listener) {
    (this.listeners[type] ??= []).push(listener);
  }
  fire(type: string, event?: unknown) {
    for (const listener of this.listeners[type] ?? []) listener(event);
  }
}

/** A fake File of `size` bytes whose slices report their range (and read as `seed` repeated). */
function makeFile(size: number, seed = 1) {
  const slices: Array<[number, number]> = [];
  return {
    name: 'clip.mov', size, type: 'video/quicktime', lastModified: 5, slices,
    slice: (a: number, b = size) => {
      slices.push([a, Math.min(b, size)]);
      const length = Math.max(0, Math.min(b, size) - a);
      return { range: `bytes ${a}-${Math.min(b, size)}`, arrayBuffer: async () => new Uint8Array(Math.min(length, 1024)).fill(seed).buffer };
    },
  };
}

/** A SHA-256 `crypto.subtle` stand-in that resolves in a microtask, like the fake timers expect. */
const fakeSubtle = {
  digest: async (_algorithm: string, data: Uint8Array) => {
    const digest = createHash('sha256').update(data).digest();
    return digest.buffer.slice(digest.byteOffset, digest.byteOffset + digest.length);
  },
};

/** A fetch Response. */
function response(status: number, body: unknown, extra: Record<string, unknown> = {}) {
  return Promise.resolve({ ok: status >= 200 && status < 300, status, redirected: false, url: '', json: () => Promise.resolve(body), ...extra });
}

/** A completed upload's redirect response. */
function redirectTo(url: string) {
  return response(200, null, { redirected: true, url });
}

/** The form's progress display: a box, a `<progress>` bar and a label. */
function makeProgressDisplay() {
  const bar = {
    value: -1,
    hasValue: true,
    ariaLabel: '',
    removeAttribute: vi.fn(function (this: any) { this.hasValue = false; }),
    setAttribute: vi.fn(function (this: any, name: string, value: string) { if (name === 'aria-label') this.ariaLabel = value; }),
  };
  const label = { textContent: '' };
  const box = {
    hidden: true,
    classList: { remove: vi.fn(function (name: string) { if (name === 'is-hidden') box.hidden = false; }) },
    querySelector: (selector: string) => (selector === 'progress' ? bar : label),
  };
  return { box, bar, label };
}

interface SetupOptions {
  file?: ReturnType<typeof makeFile> | null;
  stored?: Record<string, string>;
  withProgress?: boolean;
  dataset?: Record<string, string>;
  confirm?: boolean;
  /** False for a browser without `crypto.subtle` (an insecure context). */
  subtle?: boolean;
}

/** A page context with `utils.js` + `chunkedUpload.js` loaded and the overlay upload form registered. */
function setup(options: SetupOptions = {}) {
  const {
    file = makeFile(6),
    stored = {},
    withProgress = true,
    dataset = { progressUrl: '/overlay/settings/videos/progress', processingLabel: 'Saving…' },
    confirm = false,
    subtle = true,
  } = options;
  const display = makeProgressDisplay();
  const button = { disabled: false };
  const input = { files: file ? [file] : [] };
  class HTMLFormElement {
    dataset: Record<string, string> = { ...dataset };
    classList = { contains: (name: string) => name === 'js-overlay-upload' };
    getAttribute(name: string) {
      return name === 'action' ? BASE : null;
    }
    querySelector(selector: string) {
      if (selector === 'button[type="submit"]') return button;
      if (selector === 'input[type="file"]') return input;
      if (selector === '[data-upload-progress]') return withProgress ? display.box : null;
      return null;
    }
  }
  const document = new FakeTarget() as FakeTarget & { body: unknown };
  document.body = { dataset: { csrfToken: 'tok' } };
  const assign = vi.fn();
  const fetch = vi.fn();
  const storage: Record<string, string> = { ...stored };
  const context = {
    document,
    HTMLFormElement,
    FormData: class {
      forEach(fn: (value: unknown, key: string) => void) {
        fn('My clip', 'name');
        fn(file, 'video');
      }
    },
    URLSearchParams,
    URL,
    fetch,
    AbortController,
    setTimeout: (fn: () => void, ms: number) => setTimeout(fn, ms),
    clearTimeout: (id: ReturnType<typeof setTimeout>) => clearTimeout(id),
    window: {
      location: { assign, href: 'https://bot.example/overlay/settings', origin: 'https://bot.example' },
      crypto: { getRandomValues: (a: Uint8Array) => a.fill(171), subtle: subtle ? fakeSubtle : undefined },
      confirm: vi.fn(() => confirm),
      localStorage: {
        getItem: (k: string) => storage[k] ?? null,
        setItem: (k: string, v: string) => { storage[k] = v; },
        removeItem: (k: string) => { delete storage[k]; },
      },
    },
  };
  vm.runInNewContext(utilsSource, context);
  vm.runInNewContext("registerUploadFormHandler('js-overlay-upload', '/overlay/settings');", context);
  const form = new HTMLFormElement();
  /** Submits the form through the registered listener. */
  const submit = () => {
    const event = { target: form, preventDefault: vi.fn() };
    document.fire('submit', event);
    return event;
  };
  return { form, button, display, assign, fetch, submit, storage, context, confirmFn: context.window.confirm };
}

/** What the page remembers for an upload of `file` with ID `id` (as `startChunkedUpload` saves it). */
async function savedRecord(context: object, file: ReturnType<typeof makeFile>, id: string) {
  const fingerprint = await (context as { fileFingerprint: (f: unknown) => Promise<string> }).fileFingerprint(file);
  return JSON.stringify({ id, name: file.name, size: file.size, lastModified: file.lastModified, fingerprint });
}

/** Answers a 6-byte upload's start, status and one piece, then `complete` and the progress polls. */
function routeFetch(
  fetch: ReturnType<typeof vi.fn>,
  handlers: { complete?: () => Promise<unknown>; progress?: (init: any) => Promise<unknown> } = {},
) {
  fetch.mockImplementation((url: string, init: any) => {
    if (url === `${BASE}/start`) return response(200, { id: ID });
    if (url === `${BASE}/${ID}`) return response(200, { received: 0, size: 6 });
    if (url.includes('/chunk?offset=0')) return response(200, { received: 6 });
    if (url.endsWith('/complete')) return handlers.complete ? handlers.complete() : redirectTo(DONE_URL);
    if (url.startsWith(PROGRESS_URL)) return handlers.progress ? handlers.progress(init) : response(200, { stage: 'none' });
    return response(404, {});
  });
}

/** Waits (advancing fake timers) until the page navigates. */
async function navigated(assign: ReturnType<typeof vi.fn>) {
  for (let i = 0; i < 200 && assign.mock.calls.length === 0; i++) await vi.advanceTimersByTimeAsync(100);
  return assign.mock.calls[0]?.[0];
}

/** Lets pending promise callbacks run. */
async function flush() {
  for (let i = 0; i < 200; i++) await Promise.resolve();
}

/** A promise whose settling the test controls. */
function deferred() {
  let resolve: (value: unknown) => void = () => {};
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
}

/** Calls to the conversion-progress endpoint so far. */
function progressCalls(fetch: ReturnType<typeof vi.fn>) {
  return fetch.mock.calls.filter(([u]) => String(u).startsWith(PROGRESS_URL));
}

/** Never settles: a complete request still being processed. */
const pending = () => new Promise(() => {});

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('registerUploadFormHandler', () => {
  it('starts, sends the file in pieces and completes with the form fields', async () => {
    const file = makeFile(10 * 1024 * 1024);
    const { fetch, submit, assign, storage, button } = setup({ file });
    fetch.mockImplementation((url: string) => {
      if (url === `${BASE}/start`) return response(200, { id: ID, chunkSize: 8 * 1024 * 1024 });
      if (url === `${BASE}/${ID}`) return response(200, { received: 0, size: file.size });
      if (url.includes('/chunk?offset=0')) return response(200, { received: 8 * 1024 * 1024 });
      if (url.includes(`/chunk?offset=${8 * 1024 * 1024}`)) return response(200, { received: file.size });
      if (url.endsWith('/complete')) return redirectTo(DONE_URL);
      return response(200, { stage: 'none' });
    });
    const event = submit();
    expect(event.preventDefault).toHaveBeenCalled();
    expect(button.disabled).toBe(true);
    expect(await navigated(assign)).toBe(DONE_URL);
    const start = fetch.mock.calls.find(([u]) => u === `${BASE}/start`)!;
    expect(JSON.parse(start[1].body)).toEqual({ name: 'clip.mov', size: file.size, type: 'video/quicktime' });
    expect(start[1].headers['X-CSRF-Token']).toBe('tok');
    const complete = fetch.mock.calls.find(([u]) => u.endsWith('/complete'))!;
    expect(complete[1].body.toString()).toBe('name=My+clip');
    expect(complete[1].headers).toEqual({ 'X-CSRF-Token': 'tok', 'X-Upload-Id': PROGRESS_ID });
    expect(Object.keys(storage)).toEqual([]);
  });

  it('ignores a second submit while the first is still pending', async () => {
    const { fetch, submit, assign } = setup();
    routeFetch(fetch);
    submit();
    submit();
    await navigated(assign);
    expect(fetch.mock.calls.filter(([u]) => u === `${BASE}/start`)).toHaveLength(1);
  });

  it('shows the upload percentage as pieces are confirmed, naming the bar after each stage', async () => {
    const file = makeFile(16 * 1024 * 1024);
    const { display, fetch, submit } = setup({ file });
    const secondPiece = deferred();
    fetch.mockImplementation((url: string) => {
      if (url === `${BASE}/start`) return response(200, { id: ID });
      if (url === `${BASE}/${ID}`) return response(200, { received: 0, size: file.size });
      if (url.includes('/chunk?offset=0')) return response(200, { received: 8 * 1024 * 1024 });
      if (url.includes('/chunk?offset=')) return secondPiece.promise;
      return pending();
    });
    submit();
    expect(display.box.hidden).toBe(false);
    expect(display.bar.ariaLabel).toBe('Upload progress');
    await flush();
    expect(display.bar.value).toBe(50);
    expect(display.label.textContent).toBe('Uploading… 50%');
    secondPiece.resolve({ ok: true, status: 200, redirected: false, json: () => Promise.resolve({ received: file.size }) });
    await flush();
    expect(display.bar.ariaLabel).toBe('Processing progress');
    expect(display.label.textContent).toBe('Saving…');
  });

  it('polls the progress endpoint while the upload completes and shows the conversion percentage', async () => {
    const { display, fetch, submit } = setup();
    const progress = [{ stage: 'queued', percent: null }, { stage: 'converting', percent: 37 }];
    routeFetch(fetch, { complete: pending, progress: () => response(200, progress.shift()) });
    submit();
    await flush();
    expect(display.bar.hasValue).toBe(false);
    expect(progressCalls(fetch)[0]).toEqual([
      `${PROGRESS_URL}${PROGRESS_ID}`,
      expect.objectContaining({ headers: { Accept: 'application/json' }, signal: expect.any(AbortSignal) }),
    ]);
    expect(display.label.textContent).toBe('Waiting for another conversion to finish…');
    await vi.advanceTimersByTimeAsync(2000);
    await flush();
    expect(display.bar.value).toBe(37);
    expect(display.label.textContent).toBe('Converting… 37%');
  });

  it("shows the form's processing label while the server reports no conversion, or a failed poll", async () => {
    const { display, fetch, submit } = setup();
    const answers = [
      () => response(200, { stage: 'none', percent: null }),
      () => response(500, {}),
      () => Promise.reject(new Error('offline')),
      () => response(200, { stage: 'converting', percent: null }),
    ];
    routeFetch(fetch, { complete: pending, progress: () => answers.shift()!() });
    submit();
    await flush();
    expect(display.label.textContent).toBe('Saving…');
    for (const expected of ['Saving…', 'Saving…', 'Converting…']) {
      await vi.advanceTimersByTimeAsync(2000);
      await flush();
      expect(display.label.textContent).toBe(expected);
    }
  });

  it('abandons a poll that never answers and carries on polling', async () => {
    const { display, fetch, submit } = setup();
    let signal: AbortSignal | undefined;
    const answers = [
      (init: { signal: AbortSignal }) => {
        signal = init.signal;
        return new Promise((_resolve, reject) => init.signal.addEventListener('abort', () => reject(new Error('aborted'))));
      },
      () => response(200, { stage: 'converting', percent: 55 }),
    ];
    routeFetch(fetch, { complete: pending, progress: (init) => answers.shift()!(init) });
    submit();
    await flush();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(signal?.aborted).toBe(true);
    await vi.advanceTimersByTimeAsync(2000);
    await flush();
    expect(display.label.textContent).toBe('Converting… 55%');
  });

  it('stops polling once the complete request finishes, ignoring a late poll answer', async () => {
    const { form, display, fetch, submit, assign } = setup();
    const complete = deferred();
    const poll = deferred();
    routeFetch(fetch, { complete: () => complete.promise, progress: () => poll.promise });
    submit();
    await flush();
    complete.resolve({ ok: true, status: 200, redirected: true, url: DONE_URL });
    expect(await navigated(assign)).toBe(DONE_URL);
    poll.resolve({ ok: true, json: () => Promise.resolve({ stage: 'converting', percent: 80 }) });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(progressCalls(fetch)).toHaveLength(1);
    expect(display.label.textContent).toBe('Saving…');
    expect(form.dataset.submitting).toBeUndefined();
  });

  it.each([
    ['the fallback page when completing did not redirect', () => response(200, null), '/overlay/settings'],
    ['the error page when completing fails outright', () => Promise.reject(new TypeError('network')), '/overlay/settings?error=upload_failed'],
  ])('navigates to %s', async (_label, complete, expected) => {
    const { fetch, submit, assign } = setup();
    routeFetch(fetch, { complete });
    submit();
    expect(await navigated(assign)).toBe(expected);
  });

  it('uploads without polling on a form with no progress display', async () => {
    const { fetch, submit, assign } = setup({ withProgress: false });
    routeFetch(fetch);
    submit();
    expect(await navigated(assign)).toBe(DONE_URL);
    expect(progressCalls(fetch)).toHaveLength(0);
  });

  it('shows a generic processing label and does not poll without a progress URL', async () => {
    const { display, fetch, submit } = setup({ dataset: {} });
    routeFetch(fetch, { complete: pending });
    submit();
    await flush();
    expect(display.label.textContent).toBe('Processing…');
    expect(progressCalls(fetch)).toHaveLength(0);
  });

  it('re-sends a dropped piece and resumes from the confirmed offset', async () => {
    const { fetch, submit, assign } = setup();
    let dropped = false;
    let received = 0;
    fetch.mockImplementation((url: string) => {
      if (url === `${BASE}/start`) return response(200, { id: ID });
      if (url === `${BASE}/${ID}`) return response(200, { received, size: 6 });
      if (url.includes('/chunk')) {
        if (!dropped) {
          dropped = true;
          return Promise.reject(new TypeError('network'));
        }
        received = 6;
        return response(200, { received });
      }
      if (url.endsWith('/complete')) return redirectTo(DONE_URL);
      return response(200, { stage: 'none' });
    });
    submit();
    expect(await navigated(assign)).toBe(DONE_URL);
    expect(fetch.mock.calls.filter(([u]) => u.includes('/chunk?offset=0'))).toHaveLength(2);
  });

  it('gives up with upload_failed once a piece keeps failing', async () => {
    const { fetch, submit, assign } = setup();
    fetch.mockImplementation((url: string) => {
      if (url === `${BASE}/start`) return response(200, { id: ID });
      if (url === `${BASE}/${ID}`) return response(200, { received: 0, size: 6 });
      return response(503, {});
    });
    submit();
    for (let i = 0; i < 100 && assign.mock.calls.length === 0; i++) await vi.advanceTimersByTimeAsync(1000);
    expect(assign).toHaveBeenCalledWith('/overlay/settings?error=upload_failed');
  });

  it("resumes this browser's running upload of the same file after a reload", async () => {
    const record = await savedRecord(setup().context, makeFile(6), 'old');
    const { fetch, submit, assign } = setup({ stored: { [`chunkedUpload:${BASE}`]: record } });
    fetch.mockImplementation((url: string) => {
      if (url === `${BASE}/start`) return response(409, { error: 'upload_busy', activeId: 'old' });
      if (url === `${BASE}/old`) return response(200, { received: 4, size: 6 });
      if (url.includes('/chunk?offset=4')) return response(200, { received: 6 });
      if (url.endsWith('/old/complete')) return redirectTo(DONE_URL);
      if (url.startsWith(PROGRESS_URL)) return response(200, { stage: 'none' });
      return response(500, {});
    });
    submit();
    expect(await navigated(assign)).toBe(DONE_URL);
  });

  it('reports a refused start, such as another upload in progress', async () => {
    const { fetch, submit, assign } = setup();
    fetch.mockImplementation(() => response(409, { error: 'upload_busy', activeId: 'someone-else' }));
    submit();
    expect(await navigated(assign)).toBe('/overlay/settings?error=upload_busy');
  });

  it('reports upload_failed for a refusal without a JSON error', async () => {
    const { fetch, submit, assign } = setup();
    fetch.mockImplementation(() => Promise.resolve({ ok: false, status: 502, redirected: false, json: () => Promise.reject(new Error('html')) }));
    submit();
    expect(await navigated(assign)).toBe('/overlay/settings?error=upload_failed');
  });

  it('follows a guard redirect such as not_a_streamer', async () => {
    const { fetch, submit, assign } = setup();
    fetch.mockImplementation(() => redirectTo('/overlay/settings?error=not_a_streamer'));
    submit();
    expect(await navigated(assign)).toBe('/overlay/settings?error=not_a_streamer');
  });

  it('reports an expired upload when a piece is answered 404', async () => {
    const { fetch, submit, assign } = setup();
    fetch.mockImplementation((url: string) => {
      if (url.endsWith('/start')) return response(200, { id: 'x' });
      if (url.endsWith('/x')) return response(200, { received: 0, size: 6 });
      return response(404, { error: 'not_found' });
    });
    submit();
    expect(await navigated(assign)).toBe('/overlay/settings?error=upload_expired');
  });

  it('reports invalid_file when no file was chosen', async () => {
    const { submit, assign } = setup({ file: null });
    submit();
    expect(await navigated(assign)).toBe('/overlay/settings?error=invalid_file');
  });

  it('offers to cancel an unfinished upload of a different file with the same details, then starts again', async () => {
    const record = await savedRecord(setup().context, makeFile(6, 9), 'old');
    const { fetch, submit, assign, confirmFn } = setup({ stored: { [`chunkedUpload:${BASE}`]: record }, confirm: true });
    let started = 0;
    fetch.mockImplementation((url: string, init: any) => {
      if (url === `${BASE}/start`) return ++started === 1 ? response(409, { error: 'upload_busy', activeId: 'old' }) : response(200, { id: ID });
      if (url === `${BASE}/old` && init.method === 'DELETE') return response(204, null);
      if (url === `${BASE}/${ID}`) return response(200, { received: 0, size: 6 });
      if (url.includes('/chunk?offset=0')) return response(200, { received: 6 });
      if (url.endsWith(`/${ID}/complete`)) return redirectTo(DONE_URL);
      return response(200, { stage: 'none' });
    });
    submit();
    expect(await navigated(assign)).toBe(DONE_URL);
    expect(confirmFn).toHaveBeenCalledOnce();
    expect(fetch.mock.calls.some(([u, init]) => u === `${BASE}/old` && init.method === 'DELETE')).toBe(true);
  });

  it('leaves the unfinished upload alone and reports upload_busy when the user declines to cancel it', async () => {
    const { fetch, submit, assign, confirmFn } = setup({ confirm: false });
    fetch.mockImplementation(() => response(409, { error: 'upload_busy', activeId: 'old' }));
    submit();
    expect(await navigated(assign)).toBe('/overlay/settings?error=upload_busy');
    expect(confirmFn).toHaveBeenCalledOnce();
    expect(fetch.mock.calls.some(([, init]) => init?.method === 'DELETE')).toBe(false);
  });

  it('reports upload_busy when cancelling the unfinished upload fails', async () => {
    const { fetch, submit, assign } = setup({ confirm: true });
    fetch.mockImplementation((url: string, init: any) =>
      (init.method === 'DELETE' ? response(500, {}) : response(409, { error: 'upload_busy', activeId: 'old' })));
    submit();
    expect(await navigated(assign)).toBe('/overlay/settings?error=upload_busy');
  });

  it('does not offer to cancel when the area is full of other users\' uploads', async () => {
    const { fetch, submit, assign, confirmFn } = setup({ confirm: true });
    fetch.mockImplementation(() => response(409, { error: 'upload_busy' }));
    submit();
    expect(await navigated(assign)).toBe('/overlay/settings?error=upload_busy');
    expect(confirmFn).not.toHaveBeenCalled();
  });

  it('reports upload_failed when completing answers an error page without redirecting', async () => {
    const { fetch, submit, assign } = setup();
    routeFetch(fetch, { complete: () => response(403, null) });
    submit();
    expect(await navigated(assign)).toBe('/overlay/settings?error=upload_failed');
  });

  it('keeps the upload resumable when completing never reaches the server', async () => {
    const { fetch, submit, assign, storage } = setup();
    routeFetch(fetch, { complete: () => Promise.reject(new TypeError('network')) });
    submit();
    expect(await navigated(assign)).toBe('/overlay/settings?error=upload_failed');
    expect(JSON.parse(storage[`chunkedUpload:${BASE}`]!)).toMatchObject({ id: ID, name: 'clip.mov', size: 6 });
  });

  it('sends smaller pieces after a piece fails', async () => {
    const file = makeFile(16 * 1024 * 1024);
    const { fetch, submit, assign } = setup({ file });
    let received = 0;
    let failed = false;
    fetch.mockImplementation((url: string, init: any) => {
      if (url === `${BASE}/start`) return response(200, { id: ID });
      if (url === `${BASE}/${ID}`) return response(200, { received, size: file.size });
      if (url.includes('/chunk?offset=')) {
        if (!failed) {
          failed = true;
          return Promise.reject(new TypeError('timed out'));
        }
        received += Number(String(init.body.range).split('-')[1]) - Number(String(init.body.range).split(' ')[1]!.split('-')[0]);
        return response(200, { received });
      }
      if (url.endsWith('/complete')) return redirectTo(DONE_URL);
      return response(200, { stage: 'none' });
    });
    submit();
    expect(await navigated(assign)).toBe(DONE_URL);
    const pieces = fetch.mock.calls.filter(([u]) => String(u).includes('/chunk?offset=')).map(([, init]) => init.body.range);
    expect(pieces[0]).toBe(`bytes 0-${8 * 1024 * 1024}`);
    expect(pieces[1]).toBe(`bytes 0-${4 * 1024 * 1024}`);
  });

  it('does not resume when the browser cannot fingerprint the file', async () => {
    const saved = JSON.stringify({ id: 'old', name: 'clip.mov', size: 6, lastModified: 5, fingerprint: null });
    const { fetch, submit, assign, confirmFn } = setup({ stored: { [`chunkedUpload:${BASE}`]: saved }, subtle: false });
    fetch.mockImplementation(() => response(409, { error: 'upload_busy', activeId: 'old' }));
    submit();
    expect(await navigated(assign)).toBe('/overlay/settings?error=upload_busy');
    expect(confirmFn).toHaveBeenCalledOnce();
  });

  it.each([
    ['another origin', 'https://evil.example/phish'],
    ['a javascript: URL', 'javascript:alert(1)'],
  ])('never navigates to %s, reporting upload_failed instead', async (_label, url) => {
    const { fetch, submit, assign } = setup();
    routeFetch(fetch, { complete: () => redirectTo(url) });
    submit();
    expect(await navigated(assign)).toBe('/overlay/settings?error=upload_failed');
  });
});
