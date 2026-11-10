import { describe, it, expect, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import vm from 'vm';

const scriptPath = path.join(__dirname, '../../public/streams-live-poll.js');

interface FakeResponse {
  status: number;
  ok: boolean;
  redirected: boolean;
  url: string;
  json: () => Promise<unknown>;
}

function response(status: number, body: unknown = {}, redirectedTo?: string): FakeResponse {
  return {
    status,
    ok: status >= 200 && status < 300,
    redirected: redirectedTo !== undefined,
    url: `https://panel.example${redirectedTo ?? '/admin/streams/live'}`,
    json: () => Promise.resolve(body),
  };
}

/** Lets the fetch promise chain in refreshLiveNow run to completion. */
async function settle(): Promise<void> {
  for (let i = 0; i < 10; i++) await Promise.resolve();
}

/**
 * Runs public/streams-live-poll.js in a fresh context with stubbed page helpers, a `fetch` that
 * answers `first`, and fake interval timers so the test can see whether polling was stopped.
 */
async function runScript(first: FakeResponse) {
  const messages: string[] = [];
  const intervals = new Map<number, unknown>();
  let nextId = 1;
  const context: Record<string, unknown> = {
    URL,
    AbortController,
    fetch: vi.fn(() => Promise.resolve(first)),
    document: { addEventListener: () => {}, getElementById: () => null },
    registerToggleEditHandler: () => {},
    confirmSubmit: () => false,
    setLiveTableMessage: (msg: string) => messages.push(msg),
    renderLiveRows: vi.fn(),
    setTimeout: () => 0,
    clearTimeout: () => {},
    setInterval: (fn: unknown) => {
      const id = nextId++;
      intervals.set(id, fn);
      return id;
    },
    clearInterval: (id: number) => intervals.delete(id),
  };
  vm.runInNewContext(fs.readFileSync(scriptPath, 'utf8'), context);
  await settle();
  return { messages, intervals, renderLiveRows: context.renderLiveRows as ReturnType<typeof vi.fn> };
}

describe('public/streams-live-poll.js', () => {
  it('stops polling and says the session expired when the poll is redirected to the login page', async () => {
    const { messages, intervals } = await runScript(response(200, {}, '/auth/login'));
    expect(messages).toEqual(['Session expired — reload to log in.']);
    expect(intervals.size).toBe(0);
  });

  it('stops polling on a 401', async () => {
    const { messages, intervals } = await runScript(response(401));
    expect(messages).toEqual(['Session expired — reload to log in.']);
    expect(intervals.size).toBe(0);
  });

  it('keeps polling after another failure', async () => {
    const { messages, intervals } = await runScript(response(500));
    expect(messages).toEqual(['Failed to load live data.']);
    expect(intervals.size).toBe(1);
  });

  it('renders live streams and keeps polling', async () => {
    const streams = [{ key: 'a' }];
    const { renderLiveRows, intervals } = await runScript(response(200, { streams }));
    expect(renderLiveRows).toHaveBeenCalledWith(streams);
    expect(intervals.size).toBe(1);
  });
});
