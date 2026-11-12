import { describe, it, expect, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import vm from 'vm';

const source = fs.readFileSync(path.join(__dirname, '../../public/sharedOverlayReadiness.js'), 'utf8');

/** A minimal element: enough of the DOM for the list renderer. */
function fakeElement() {
  const el: any = {
    children: [] as any[], textContent: '',
    appendChild(child: unknown) { el.children.push(child); },
    replaceChildren() { el.children = []; },
  };
  return el;
}

/** Runs the script with fake lists and returns its functions and the lists. */
function load() {
  const lists: Record<string, any> = { 'readiness-overlays': fakeElement(), 'readiness-videos': fakeElement() };
  const connectSse = vi.fn();
  const context: Record<string, unknown> = {
    document: { getElementById: (id: string) => lists[id] ?? null, createElement: () => fakeElement() },
    connectSse,
  };
  vm.createContext(context);
  vm.runInContext(`${source}\nthis.api = { describeOverlay, describeVideo, renderReadiness };`, context);
  return { api: (context as any).api, lists, connectSse };
}

const texts = (list: any) => list.children.map((c: any) => c.textContent);

describe('readiness page script', () => {
  it('describes an online overlay with its count and download', () => {
    const { api } = load();
    expect(api.describeOverlay({ login: 'bob', online: true, stored: 10, total: 12, downloading: { name: 'Clap', percent: 40 }, reportedAt: 1 }))
      .toBe('bob — online — 10/12 stored — downloading Clap 40%');
  });

  it('describes an offline overlay with its last report, or none', () => {
    const { api } = load();
    expect(api.describeOverlay({ login: 'bob', online: false, stored: 1, total: 2, downloading: null, reportedAt: null }))
      .toBe('bob — offline (no report yet) — 1/2 stored');
    expect(api.describeOverlay({ login: 'bob', online: false, stored: 1, total: 2, downloading: null, reportedAt: 1000 }))
      .toMatch(/^bob — offline \(last report .+\) — 1\/2 stored$/);
  });

  it('describes a video: tick when all ready, otherwise who is missing it', () => {
    const { api } = load();
    expect(api.describeVideo({ name: 'Clap', ready: 5, online: 5, missing: [], allReady: true }))
      .toBe('✅ Clap — ready on 5/5 connected overlays');
    expect(api.describeVideo({ name: 'Boo', ready: 3, online: 5, allReady: false, missing: [{ login: 'a', percent: 40 }, { login: 'b', percent: null }] }))
      .toBe('Boo — ready on 3/5 connected overlays; missing on a (40%), b');
  });

  it('renders both lists, with placeholders when empty, and opens the stream', () => {
    const { api, lists, connectSse } = load();
    api.renderReadiness({ overlays: [], videos: [] });
    expect(texts(lists['readiness-overlays'])).toEqual(['No shared overlays have connected yet.']);
    expect(texts(lists['readiness-videos'])).toEqual(['No enabled shared videos.']);
    api.renderReadiness({ overlays: [{ login: 'a', online: true, stored: 0, total: 1, downloading: null, reportedAt: 1 }], videos: [] });
    expect(texts(lists['readiness-overlays'])).toEqual(['a — online — 0/1 stored']);
    expect(connectSse).toHaveBeenCalledWith('/overlay/shared/settings/readiness/events', expect.any(Function));
  });
});
