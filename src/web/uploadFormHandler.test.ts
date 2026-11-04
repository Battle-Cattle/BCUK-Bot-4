import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import vm from 'vm';

// utils.js plus chunkedUpload.js, as the upload pages load them.
const utilsSource = ['utils.js', 'chunkedUpload.js']
  .map((name) => fs.readFileSync(path.join(__dirname, '../../public', name), 'utf8'))
  .join('\n');
const ACTION = 'https://bot.example/overlay/settings/videos/upload';

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

/** Fake XMLHttpRequest recording what was sent; the test drives its events. */
class FakeXhr extends FakeTarget {
  static last: FakeXhr | undefined;
  upload = new FakeTarget();
  headers: Record<string, string> = {};
  method = '';
  url = '';
  body: unknown;
  status = 0;
  responseURL = '';
  constructor() {
    super();
    FakeXhr.last = this;
  }
  open(method: string, url: string) {
    this.method = method;
    this.url = url;
  }
  setRequestHeader(name: string, value: string) {
    this.headers[name] = value;
  }
  send(body: unknown) {
    this.body = body;
  }
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

/** Builds a page context with `utils.js` loaded and the overlay upload handler registered. */
function setup(options: { withProgress?: boolean; dataset?: Record<string, string> } = {}) {
  const { withProgress = true, dataset = { progressUrl: '/overlay/settings/videos/progress', processingLabel: 'Saving…' } } = options;
  const display = makeProgressDisplay();
  const button = { disabled: false };
  class HTMLFormElement {
    action = ACTION;
    dataset: Record<string, string> = { ...dataset };
    classList = { contains: (name: string) => name === 'js-overlay-upload' };
    querySelector(selector: string) {
      if (selector === 'button[type="submit"]') return button;
      if (selector === '[data-upload-progress]') return withProgress ? display.box : null;
      return null;
    }
  }
  const document = new FakeTarget() as FakeTarget & { body: unknown };
  document.body = { dataset: { csrfToken: 'tok' } };
  const assign = vi.fn();
  const fetch = vi.fn();
  const context = {
    document,
    HTMLFormElement,
    XMLHttpRequest: FakeXhr,
    FormData: class { constructor(public form: unknown) {} },
    fetch,
    AbortController,
    setTimeout: (fn: () => void, ms: number) => setTimeout(fn, ms),
    clearTimeout: (id: ReturnType<typeof setTimeout>) => clearTimeout(id),
    window: { location: { assign }, crypto: { getRandomValues: (a: Uint8Array) => a.fill(171) } },
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
  return { form, button, display, assign, fetch, submit };
}

/** A resolved fetch Response carrying `body` as JSON. */
function jsonResponse(body: unknown, ok = true) {
  return Promise.resolve({ ok, json: () => Promise.resolve(body) });
}

/** Lets pending promise callbacks (the poll's fetch chain) run. */
async function flush() {
  for (let i = 0; i < 5; i++) await Promise.resolve();
}

beforeEach(() => {
  FakeXhr.last = undefined;
});

afterEach(() => {
  vi.useRealTimers();
});

describe('registerUploadFormHandler', () => {
  it('posts the form with XHR, sending the CSRF token and a fresh upload ID', () => {
    const { form, button, display, submit } = setup();
    const event = submit();
    const xhr = FakeXhr.last!;
    expect(event.preventDefault).toHaveBeenCalled();
    expect(button.disabled).toBe(true);
    expect([xhr.method, xhr.url]).toEqual(['POST', ACTION]);
    expect(xhr.headers['X-CSRF-Token']).toBe('tok');
    expect(xhr.headers['X-Upload-Id']).toBe('ab'.repeat(16));
    expect((xhr.body as { form: unknown }).form).toBe(form);
    expect(display.box.hidden).toBe(false);
    expect(display.label.textContent).toBe('Uploading… 0%');
  });

  it('names the bar after the stage it is showing', () => {
    const { display, fetch, submit } = setup();
    fetch.mockImplementation(() => new Promise(() => {}));
    submit();
    expect(display.bar.ariaLabel).toBe('Upload progress');
    FakeXhr.last!.upload.fire('load');
    expect(display.bar.ariaLabel).toBe('Processing progress');
  });

  it('abandons a poll that never answers and carries on polling', async () => {
    vi.useFakeTimers();
    const { display, fetch, submit } = setup();
    let signal: AbortSignal | undefined;
    fetch.mockImplementationOnce((_url: string, init: { signal: AbortSignal }) => {
      signal = init.signal;
      return new Promise((_resolve, reject) => init.signal.addEventListener('abort', () => reject(new Error('aborted'))));
    }).mockImplementationOnce(() => jsonResponse({ stage: 'converting', percent: 55 }));
    submit();
    FakeXhr.last!.upload.fire('load');
    await vi.advanceTimersByTimeAsync(10_000);
    expect(signal?.aborted).toBe(true);
    await vi.advanceTimersByTimeAsync(2000);
    await flush();
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(display.label.textContent).toBe('Converting… 55%');
  });

  it('ignores a second submit while the first is still pending', () => {
    const { submit } = setup();
    submit();
    const first = FakeXhr.last;
    submit();
    expect(FakeXhr.last).toBe(first);
  });

  it('shows the upload percentage as the file is sent', () => {
    const { display, submit } = setup();
    submit();
    FakeXhr.last!.upload.fire('progress', { lengthComputable: true, loaded: 42, total: 100 });
    expect(display.bar.value).toBe(42);
    expect(display.label.textContent).toBe('Uploading… 42%');
    FakeXhr.last!.upload.fire('progress', { lengthComputable: false, loaded: 90, total: 0 });
    expect(display.bar.value).toBe(42);
  });

  it('once the file is sent, polls the progress endpoint and shows the conversion percentage', async () => {
    vi.useFakeTimers();
    const { display, fetch, submit } = setup();
    fetch.mockImplementationOnce(() => jsonResponse({ stage: 'queued', percent: null }))
      .mockImplementationOnce(() => jsonResponse({ stage: 'converting', percent: 37 }));
    submit();
    FakeXhr.last!.upload.fire('load');
    expect(display.bar.hasValue).toBe(false);
    expect(fetch).toHaveBeenCalledWith(
      `/overlay/settings/videos/progress/${'ab'.repeat(16)}`,
      expect.objectContaining({ headers: { Accept: 'application/json' }, signal: expect.any(AbortSignal) }),
    );
    await flush();
    expect(display.label.textContent).toBe('Waiting for another conversion to finish…');
    await vi.advanceTimersByTimeAsync(2000);
    await flush();
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(display.bar.value).toBe(37);
    expect(display.label.textContent).toBe('Converting… 37%');
  });

  it('shows the form\'s processing label while the server reports no conversion, or a failed poll', async () => {
    vi.useFakeTimers();
    const { display, fetch, submit } = setup();
    fetch.mockImplementationOnce(() => jsonResponse({ stage: 'none', percent: null }))
      .mockImplementationOnce(() => jsonResponse({}, false))
      .mockImplementationOnce(() => Promise.reject(new Error('offline')))
      .mockImplementationOnce(() => jsonResponse({ stage: 'converting', percent: null }));
    submit();
    FakeXhr.last!.upload.fire('load');
    await flush();
    expect(display.label.textContent).toBe('Saving…');
    await vi.advanceTimersByTimeAsync(2000);
    await flush();
    expect(display.label.textContent).toBe('Saving…');
    await vi.advanceTimersByTimeAsync(2000);
    await flush();
    expect(display.label.textContent).toBe('Saving…');
    await vi.advanceTimersByTimeAsync(2000);
    await flush();
    expect(display.label.textContent).toBe('Converting…');
  });

  it('stops polling once the upload request finishes', async () => {
    vi.useFakeTimers();
    const { form, fetch, submit } = setup();
    fetch.mockImplementation(() => jsonResponse({ stage: 'converting', percent: 10 }));
    submit();
    const xhr = FakeXhr.last!;
    xhr.upload.fire('load');
    await flush();
    xhr.status = 200;
    xhr.responseURL = 'https://bot.example/overlay/settings?success=video_uploaded';
    xhr.fire('load');
    xhr.fire('loadend');
    await vi.advanceTimersByTimeAsync(10_000);
    expect(fetch).toHaveBeenCalledOnce();
    expect(form.dataset.submitting).toBeUndefined();
  });

  it('ignores a poll that answers after the upload has finished', async () => {
    let answer: (value: unknown) => void = () => {};
    const { display, fetch, submit } = setup();
    fetch.mockImplementationOnce(() => new Promise((resolve) => { answer = resolve; }));
    submit();
    const xhr = FakeXhr.last!;
    xhr.upload.fire('load');
    xhr.fire('loadend');
    answer({ ok: true, json: () => Promise.resolve({ stage: 'converting', percent: 80 }) });
    await flush();
    expect(display.label.textContent).toBe('Saving…');
  });

  it.each([
    ['the page the server redirected to', 200, 'https://bot.example/overlay/settings?success=video_uploaded', 'https://bot.example/overlay/settings?success=video_uploaded'],
    ['the fallback page for an OK response that did not redirect', 200, ACTION, '/overlay/settings'],
    ['the error page for a non-OK response', 403, ACTION, '/overlay/settings?error=upload_failed'],
  ])('navigates to %s', (_label, status, responseURL, expected) => {
    const { assign, submit } = setup();
    submit();
    const xhr = FakeXhr.last!;
    xhr.status = status;
    xhr.responseURL = responseURL;
    xhr.fire('load');
    expect(assign).toHaveBeenCalledWith(expected);
  });

  it('navigates to the error page when the request fails outright', () => {
    const { assign, submit } = setup();
    submit();
    FakeXhr.last!.fire('error');
    expect(assign).toHaveBeenCalledWith('/overlay/settings?error=upload_failed');
  });

  it('uploads without showing or polling anything on a form with no progress display', () => {
    const { fetch, submit } = setup({ withProgress: false });
    submit();
    FakeXhr.last!.upload.fire('progress', { lengthComputable: true, loaded: 1, total: 2 });
    FakeXhr.last!.upload.fire('load');
    expect(fetch).not.toHaveBeenCalled();
  });

  it('shows a generic processing label and does not poll without a progress URL', () => {
    const { display, fetch, submit } = setup({ dataset: {} });
    submit();
    FakeXhr.last!.upload.fire('load');
    expect(display.label.textContent).toBe('Processing…');
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe('chunked uploads (data-chunked-url)', () => {
  const BASE = '/overlay/settings/videos/upload';

  /** A fake File of `size` bytes whose slices report their range. */
  function makeFile(size: number) {
    return { name: 'clip.mov', size, type: 'video/quicktime', lastModified: 5, slice: (a: number, b: number) => `bytes ${a}-${Math.min(b, size)}` };
  }

  /** A fetch Response. */
  function response(status: number, body: unknown, extra: Record<string, unknown> = {}) {
    return Promise.resolve({ ok: status >= 200 && status < 300, status, redirected: false, url: '', json: () => Promise.resolve(body), ...extra });
  }

  /** A page context with `utils.js` loaded and a chunked overlay upload form. */
  function setupChunked(file: ReturnType<typeof makeFile> | null, stored: Record<string, string> = {}) {
    const button = { disabled: false };
    const input = { files: file ? [file] : [] };
    class HTMLFormElement {
      action = ACTION;
      dataset: Record<string, string> = { chunkedUrl: BASE };
      classList = { contains: (name: string) => name === 'js-overlay-upload' };
      querySelector(selector: string) {
        if (selector === 'button[type="submit"]') return button;
        if (selector === 'input[type="file"]') return input;
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
      XMLHttpRequest: FakeXhr,
      FormData: class {
        forEach(fn: (value: unknown, key: string) => void) {
          fn('My clip', 'name');
          fn(file, 'video');
        }
      },
      URLSearchParams,
      fetch,
      AbortController,
      setTimeout: (fn: () => void, ms: number) => setTimeout(fn, ms),
      clearTimeout: (id: ReturnType<typeof setTimeout>) => clearTimeout(id),
      window: {
        location: { assign },
        crypto: { getRandomValues: (a: Uint8Array) => a.fill(171) },
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
    const submit = () => document.fire('submit', { target: form, preventDefault: vi.fn() });
    return { form, assign, fetch, submit, storage };
  }

  /** Waits until the page navigates. */
  async function navigated(assign: ReturnType<typeof vi.fn>) {
    for (let i = 0; i < 200 && assign.mock.calls.length === 0; i++) await vi.advanceTimersByTimeAsync(100);
    return assign.mock.calls[0]?.[0];
  }

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('starts, sends the file in pieces and completes with the form fields', async () => {
    const file = makeFile(10 * 1024 * 1024);
    const { fetch, submit, assign, storage } = setupChunked(file);
    const id = '0f8fad5b-d9cb-469f-a165-70867728950e';
    fetch.mockImplementation((url: string) => {
      if (url === `${BASE}/start`) return response(200, { id, chunkSize: 8 * 1024 * 1024 });
      if (url === `${BASE}/${id}`) return response(200, { received: 0, size: file.size });
      if (url.includes('/chunk?offset=0')) return response(200, { received: 8 * 1024 * 1024 });
      if (url.includes(`/chunk?offset=${8 * 1024 * 1024}`)) return response(200, { received: file.size });
      if (url.endsWith('/complete')) return response(200, null, { redirected: true, url: '/overlay/settings?success=video_uploaded' });
      return response(404, {});
    });
    submit();
    expect(await navigated(assign)).toBe('/overlay/settings?success=video_uploaded');
    const start = fetch.mock.calls.find(([u]) => u === `${BASE}/start`)!;
    expect(JSON.parse(start[1].body)).toEqual({ name: 'clip.mov', size: file.size, type: 'video/quicktime' });
    expect(start[1].headers['X-CSRF-Token']).toBe('tok');
    const complete = fetch.mock.calls.find(([u]) => u.endsWith('/complete'))!;
    expect(complete[1].body.toString()).toBe('name=My+clip');
    expect(Object.keys(storage)).toEqual([]);
  });

  it('re-sends a dropped piece and resumes from the confirmed offset', async () => {
    const file = makeFile(6);
    const { fetch, submit, assign } = setupChunked(file);
    const id = 'abc';
    let dropped = false;
    let received = 0;
    fetch.mockImplementation((url: string) => {
      if (url === `${BASE}/start`) return response(200, { id });
      if (url === `${BASE}/${id}`) return response(200, { received, size: 6 });
      if (url.includes('/chunk')) {
        if (!dropped) {
          dropped = true;
          return Promise.reject(new TypeError('network'));
        }
        received = 6;
        return response(200, { received });
      }
      return response(200, null, { redirected: true, url: '/overlay/settings?success=video_uploaded' });
    });
    submit();
    expect(await navigated(assign)).toBe('/overlay/settings?success=video_uploaded');
    expect(fetch.mock.calls.filter(([u]) => u.includes('/chunk?offset=0'))).toHaveLength(2);
  });

  it("resumes this browser's running upload of the same file after a reload", async () => {
    const file = makeFile(6);
    const id = 'old';
    const saved = { [`chunkedUpload:${BASE}`]: JSON.stringify({ id, name: 'clip.mov', size: 6, lastModified: 5 }) };
    const { fetch, submit, assign } = setupChunked(file, saved);
    fetch.mockImplementation((url: string) => {
      if (url === `${BASE}/start`) return response(409, { error: 'upload_busy', activeId: id });
      if (url === `${BASE}/${id}`) return response(200, { received: 4, size: 6 });
      if (url.includes('/chunk?offset=4')) return response(200, { received: 6 });
      if (url.endsWith(`/${id}/complete`)) return response(200, null, { redirected: true, url: '/overlay/settings?success=video_uploaded' });
      return response(500, {});
    });
    submit();
    expect(await navigated(assign)).toBe('/overlay/settings?success=video_uploaded');
  });

  it('reports a refused start, such as another upload in progress', async () => {
    const { fetch, submit, assign } = setupChunked(makeFile(6));
    fetch.mockImplementation(() => response(409, { error: 'upload_busy', activeId: 'someone-else' }));
    submit();
    expect(await navigated(assign)).toBe('/overlay/settings?error=upload_busy');
  });

  it('follows a guard redirect such as not_a_streamer', async () => {
    const { fetch, submit, assign } = setupChunked(makeFile(6));
    fetch.mockImplementation(() => response(200, null, { redirected: true, url: '/overlay/settings?error=not_a_streamer' }));
    submit();
    expect(await navigated(assign)).toBe('/overlay/settings?error=not_a_streamer');
  });

  it('reports an expired upload when a piece is answered 404', async () => {
    const { fetch, submit, assign } = setupChunked(makeFile(6));
    fetch.mockImplementation((url: string) => {
      if (url.endsWith('/start')) return response(200, { id: 'x' });
      if (url.endsWith('/x')) return response(200, { received: 0, size: 6 });
      return response(404, { error: 'not_found' });
    });
    submit();
    expect(await navigated(assign)).toBe('/overlay/settings?error=upload_expired');
  });

  it('reports invalid_file when no file was chosen', async () => {
    const { submit, assign } = setupChunked(null);
    submit();
    expect(await navigated(assign)).toBe('/overlay/settings?error=invalid_file');
  });
});
