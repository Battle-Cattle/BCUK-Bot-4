import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import vm from 'vm';

const utilsSource = fs.readFileSync(path.join(__dirname, '../../public/utils.js'), 'utf8');
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
  const bar = { value: -1, hasValue: true, removeAttribute: vi.fn(function (this: any) { this.hasValue = false; }) };
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
    expect(fetch).toHaveBeenCalledWith(`/overlay/settings/videos/progress/${'ab'.repeat(16)}`, { headers: { Accept: 'application/json' } });
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
