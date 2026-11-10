import { describe, it, expect, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import vm from 'vm';

const scriptPath = path.join(__dirname, '../../public/dashboard-voice.js');

interface FakeResponse {
  status: number;
  ok: boolean;
  json: () => Promise<unknown>;
}

function response(status: number, body: unknown = {}): FakeResponse {
  return { status, ok: status >= 200 && status < 300, json: () => Promise.resolve(body) };
}

/**
 * Runs public/dashboard-voice.js in a fresh context with a stub dropdown, `fetch` answering
 * from `responses` in order, and a `setTimeout` that records each poll delay without firing.
 */
function runScript(responses: FakeResponse[]) {
  const select = { innerHTML: '', disabled: false, value: '', appendChild: vi.fn() };
  const delays: number[] = [];
  const fetch = vi.fn(() => {
    const next = responses.shift();
    if (!next) throw new Error('unexpected fetch');
    return Promise.resolve(next);
  });
  const context: Record<string, unknown> = {
    document: {
      getElementById: (id: string) => (id === 'voice-channel-select' ? select : null),
      createElement: () => ({}),
    },
    fetch,
    setTimeout: (_fn: unknown, ms: number) => {
      delays.push(ms);
      return delays.length;
    },
    clearTimeout: () => {},
  };
  vm.runInNewContext(fs.readFileSync(scriptPath, 'utf8'), context);
  const load = context.loadVoiceChannels as () => Promise<void>;
  return { select, delays, fetch, load };
}

describe('public/dashboard-voice.js loadVoiceChannels', () => {
  it('stops polling and says the session expired on a 401', async () => {
    const { select, delays, load } = runScript([response(401)]);
    await load();
    expect(select.innerHTML).toContain('Session expired');
    expect(select.disabled).toBe(true);
    expect(delays).toEqual([]);
  });

  it('backs off after failures in a row, up to once a minute', async () => {
    const { select, delays, load } = runScript(Array.from({ length: 6 }, () => response(429)));
    for (let i = 0; i < 6; i++) await load();
    expect(delays).toEqual([5000, 10000, 20000, 40000, 60000, 60000]);
    expect(select.innerHTML).toContain('Failed to load channels');
  });

  it('backs off on an error body and a network error too, and resets after a successful load', async () => {
    const { delays, fetch, load } = runScript([
      response(200, { ok: false }),
      response(200, { ok: true, channels: [{ id: '1', name: 'General' }] }),
    ]);
    await load();
    await load();
    fetch.mockImplementationOnce(() => Promise.reject(new Error('offline')));
    await load();
    expect(delays).toEqual([5000, 30000, 5000]);
  });
});
