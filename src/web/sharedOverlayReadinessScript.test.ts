import { describe, it, expect, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import vm from 'vm';

const source = fs.readFileSync(path.join(__dirname, '../../public/sharedOverlayReadiness.js'), 'utf8');

/** A minimal element: enough of the DOM for the renderer. */
function fakeElement(dataset: Record<string, string> = {}) {
  const el: any = {
    children: [] as any[], textContent: '', dataset,
    appendChild(child: unknown) { el.children.push(child); },
    replaceChildren() { el.children = []; },
    hidden: true,
    classes: new Set<string>(),
    classList: { toggle(name: string, on: boolean) { if (on) el.classes.add(name); else el.classes.delete(name); } },
  };
  return el;
}

/** Runs the script with fake page elements (one table cell pair per video id) and returns its functions and elements. */
function load(rowIds: string[] = []) {
  const els: Record<string, any> = { 'readiness-overlays': fakeElement(), 'readiness-summary': fakeElement(), 'readiness-status': fakeElement() };
  const videoCells = rowIds.map((id) => fakeElement({ readinessVideo: id }));
  const pushCells = rowIds.map((id) => fakeElement({ readinessPush: id }));
  const connectSse = vi.fn();
  const context: Record<string, unknown> = {
    document: {
      getElementById: (id: string) => els[id] ?? null, createElement: () => fakeElement(),
      querySelectorAll: (sel: string) => {
        if (sel === '[data-readiness-video]') return videoCells;
        if (sel === '[data-readiness-push]') return pushCells;
        return [...videoCells, ...pushCells];
      },
      body: { dataset: { csrfToken: 'tok' } },
    },
    connectSse,
  };
  vm.createContext(context);
  vm.runInContext(`${source}\nthis.api = { describeOverlay, describeVideo, renderReadiness, setReadinessStale, buildPushForm };`, context);
  return { api: (context as any).api, els, videoCells, pushCells, connectSse };
}

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
    expect(api.describeVideo({ ready: 5, online: 5, missing: [], allReady: true }))
      .toBe('✅ Ready on 5/5 connected overlays');
    expect(api.describeVideo({ ready: 3, online: 5, allReady: false, missing: [{ login: 'a', percent: 40 }, { login: 'b', percent: null }] }))
      .toBe('Ready on 3/5 connected overlays; missing on a (40%), b');
  });

  it('builds a push form that posts with the CSRF token, greyed out when every connected overlay has the video', () => {
    const { api } = load();
    const form = api.buildPushForm({ id: 7, allReady: false, online: 3 });
    expect(form).toMatchObject({ method: 'POST', action: '/overlay/shared/settings/videos/7/push' });
    expect(form.children[0]).toMatchObject({ type: 'hidden', name: '_csrf', value: 'tok' });
    expect(form.children[1]).toMatchObject({ textContent: 'Push to overlays', disabled: false });
    expect(api.buildPushForm({ id: 7, allReady: true, online: 3 }).children[1].disabled).toBe(true);
    expect(api.buildPushForm({ id: 7, allReady: false, online: 0 }).children[1].disabled).toBe(true);
  });

  it('fills each video row from the snapshot, with its own push form', () => {
    const { api, videoCells, pushCells } = load(['1', '2']);
    api.renderReadiness({ overlays: [], videos: [
      { id: 1, ready: 0, online: 1, missing: [{ login: 'a', percent: null }], allReady: false },
      { id: 2, ready: 1, online: 1, missing: [], allReady: true },
    ] });
    expect(videoCells.map((c) => c.textContent)).toEqual(['Ready on 0/1 connected overlays; missing on a', '✅ Ready on 1/1 connected overlays']);
    expect(pushCells[0].children[0].action).toBe('/overlay/shared/settings/videos/1/push');
    expect(pushCells[0].children[0].children[1].disabled).toBe(false);
    expect(pushCells[1].children[0].children[1].disabled).toBe(true);
  });

  it('handles a row with no snapshot entry (video added since) and a snapshot with no videos', () => {
    const { api, videoCells, pushCells } = load(['5']);
    api.renderReadiness({ overlays: [], videos: [] });
    expect(videoCells[0].textContent).toBe('Waiting for the next update…');
    expect(pushCells[0].children).toHaveLength(0);
  });

  it('shows the live connected count and per-overlay list, with an empty state', () => {
    const { api, els } = load();
    api.renderReadiness({ overlays: [], videos: [] });
    expect(els['readiness-summary'].textContent).toBe('No shared overlays have connected yet.');
    expect(els['readiness-overlays'].children).toHaveLength(0);
    api.renderReadiness({ overlays: [
      { login: 'a', online: true, stored: 0, total: 1, downloading: null, reportedAt: 1 },
      { login: 'b', online: false, stored: 1, total: 1, downloading: null, reportedAt: null },
    ], videos: [] });
    expect(els['readiness-summary'].textContent).toBe('1 shared overlay connected right now.');
    expect(els['readiness-overlays'].children.map((c: any) => c.textContent)).toEqual(['a — online — 0/1 stored', 'b — offline (no report yet) — 1/1 stored']);
    api.renderReadiness({ overlays: [
      { login: 'a', online: true, stored: 0, total: 1, downloading: null, reportedAt: 1 },
      { login: 'b', online: true, stored: 1, total: 1, downloading: null, reportedAt: 1 },
    ], videos: [] });
    expect(els['readiness-summary'].textContent).toBe('2 shared overlays connected right now.');
    api.renderReadiness({ overlays: [{ login: 'a', online: false, stored: 0, total: 1, downloading: null, reportedAt: 1 }], videos: [] });
    expect(els['readiness-summary'].textContent).toBe('0 shared overlays connected right now.');
  });

  it('opens the stream', () => {
    const { connectSse } = load();
    expect(connectSse).toHaveBeenCalledWith('/overlay/shared/settings/readiness/events', expect.any(Function), { onError: expect.any(Function) });
  });

  it('marks every place stale when the stream errors and clears it on the next snapshot', () => {
    const { api, els, videoCells, pushCells, connectSse } = load(['1']);
    const options = connectSse.mock.lastCall?.[2];
    expect(options).toBeDefined();
    options.onError();
    expect(els['readiness-status'].hidden).toBe(false);
    for (const el of [els['readiness-overlays'], els['readiness-summary'], videoCells[0], pushCells[0]]) expect(el.classes.has('stale')).toBe(true);
    api.renderReadiness({ overlays: [], videos: [] });
    expect(els['readiness-status'].hidden).toBe(true);
    for (const el of [els['readiness-overlays'], els['readiness-summary'], videoCells[0], pushCells[0]]) expect(el.classes.has('stale')).toBe(false);
  });
});
