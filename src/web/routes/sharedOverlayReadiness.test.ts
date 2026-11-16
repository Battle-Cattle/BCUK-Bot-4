import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  parseReadinessReport, recordReadinessReport, getReadinessSnapshot, onReadinessChange, resetReadiness,
} from './sharedOverlayReadiness';

const videos = [{ id: 1, name: 'Clap' }, { id: 2, name: 'Boo' }];
const ids = new Set([1, 2]);

beforeEach(() => { resetReadiness(); });

describe('parseReadinessReport', () => {
  it('accepts a report of listed ids, de-duplicated, with a rounded percentage', () => {
    expect(parseReadinessReport({ stored: [1, 1, 2], downloading: { id: 2, percent: 40.4 } }, ids))
      .toEqual({ stored: [1, 2], downloading: { id: 2, percent: 40 } });
    expect(parseReadinessReport({ stored: [] }, ids)).toEqual({ stored: [], downloading: null });
  });

  it.each([
    ['a non-object', 'x'], ['null', null], ['no stored list', {}], ['a non-array stored', { stored: 1 }],
    ['an unknown stored id', { stored: [3] }], ['a non-number id', { stored: ['1'] }],
    ['an unknown downloading id', { stored: [], downloading: { id: 3, percent: 1 } }],
    ['a bad percentage', { stored: [], downloading: { id: 1, percent: 101 } }],
    ['a non-finite percentage', { stored: [], downloading: { id: 1, percent: NaN } }],
    ['a missing percentage', { stored: [], downloading: { id: 1 } }],
    ['too many ids', { stored: Array.from({ length: 1001 }, () => 1) }],
  ])('rejects %s', (_label, body) => {
    expect(parseReadinessReport(body, ids)).toBeNull();
  });
});

describe('readiness store', () => {
  it('replaces the previous report and notifies listeners', () => {
    const listener = vi.fn();
    onReadinessChange(listener);
    recordReadinessReport('bob', { stored: [1], downloading: null }, 100);
    recordReadinessReport('bob', { stored: [1, 2], downloading: null }, 200);
    const row = getReadinessSnapshot(videos, new Set(['bob'])).overlays[0];
    expect(row).toMatchObject({ login: 'bob', stored: 2, reportedAt: 200 });
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it('stops notifying after unsubscribe', () => {
    const listener = vi.fn();
    onReadinessChange(listener)();
    recordReadinessReport('bob', { stored: [], downloading: null });
    expect(listener).not.toHaveBeenCalled();
  });
});

describe('getReadinessSnapshot', () => {
  it('counts stored videos and the download per overlay, and lists connected overlays with no report', () => {
    recordReadinessReport('alice', { stored: [1], downloading: { id: 2, percent: 40 } }, 5);
    const { overlays } = getReadinessSnapshot(videos, new Set(['alice', 'carol']));
    expect(overlays).toEqual([
      { login: 'alice', online: true, stored: 1, total: 2, downloading: { id: 2, name: 'Boo', percent: 40 }, reportedAt: 5 },
      { login: 'carol', online: true, stored: 0, total: 2, downloading: null, reportedAt: null },
    ]);
  });

  it('ignores stored ids no longer on the list', () => {
    recordReadinessReport('alice', { stored: [1, 2], downloading: null });
    expect(getReadinessSnapshot([{ id: 1, name: 'Clap' }], new Set(['alice'])).overlays[0]).toMatchObject({ stored: 1, total: 1 });
  });

  it('keeps an offline overlay\'s last report, marked offline, and out of the per-video counts', () => {
    recordReadinessReport('alice', { stored: [1, 2], downloading: null }, 9);
    recordReadinessReport('bob', { stored: [1], downloading: null }, 8);
    const snap = getReadinessSnapshot(videos, new Set(['bob']));
    expect(snap.overlays.find((o) => o.login === 'alice')).toMatchObject({ online: false, stored: 2, reportedAt: 9 });
    expect(snap.videos.find((v) => v.id === 2)).toMatchObject({ ready: 0, online: 1, allReady: false });
  });

  it('reconnecting brings the overlay back online with its report', () => {
    recordReadinessReport('alice', { stored: [1], downloading: null });
    expect(getReadinessSnapshot(videos, new Set()).overlays[0]).toMatchObject({ online: false });
    expect(getReadinessSnapshot(videos, new Set(['alice'])).overlays[0]).toMatchObject({ online: true });
  });

  it('per video: ready counts, who is missing it with download percentages, and the all-ready tick', () => {
    recordReadinessReport('alice', { stored: [1, 2], downloading: null });
    recordReadinessReport('bob', { stored: [1], downloading: { id: 2, percent: 70 } });
    recordReadinessReport('carol', { stored: [], downloading: null });
    const { videos: rows } = getReadinessSnapshot(videos, new Set(['alice', 'bob', 'carol']));
    expect(rows[0]).toMatchObject({ id: 1, ready: 2, online: 3, allReady: false, missing: [{ login: 'carol', percent: null }] });
    expect(rows[1]).toMatchObject({
      id: 2, ready: 1, online: 3, allReady: false,
      missing: [{ login: 'bob', percent: 70 }, { login: 'carol', percent: null }],
    });
    recordReadinessReport('carol', { stored: [1, 2], downloading: null });
    recordReadinessReport('bob', { stored: [1, 2], downloading: null });
    expect(getReadinessSnapshot(videos, new Set(['alice', 'bob', 'carol'])).videos.every((v) => v.allReady)).toBe(true);
  });

  it('is not all-ready with nobody connected', () => {
    expect(getReadinessSnapshot(videos, new Set()).videos[0]).toMatchObject({ online: 0, allReady: false });
  });
});
