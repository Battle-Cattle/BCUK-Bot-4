import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createPerViewerCooldown, type PerViewerCooldown } from './perViewerCooldown';

let cooldown: PerViewerCooldown;

beforeEach(() => {
  vi.useFakeTimers();
  cooldown = createPerViewerCooldown();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('tryClaim', () => {
  it('succeeds on the first claim for a (streamer, viewer) pair', () => {
    expect(cooldown.tryClaim(1, 'viewer', 60)).toBe(true);
  });

  it('fails on a second claim within the cooldown window', () => {
    cooldown.tryClaim(1, 'viewer', 60);
    expect(cooldown.tryClaim(1, 'viewer', 60)).toBe(false);
  });

  it('succeeds again once the cooldown has elapsed', () => {
    cooldown.tryClaim(1, 'viewer', 60);
    vi.advanceTimersByTime(60_000);
    expect(cooldown.tryClaim(1, 'viewer', 60)).toBe(true);
  });

  it('does not share cooldown state between different streamers for the same viewer', () => {
    cooldown.tryClaim(1, 'viewer', 60);
    expect(cooldown.tryClaim(2, 'viewer', 60)).toBe(true);
  });

  it('does not share cooldown state between different viewers on the same streamer', () => {
    cooldown.tryClaim(1, 'alice', 60);
    expect(cooldown.tryClaim(1, 'bob', 60)).toBe(true);
  });

  it('honors a shorter configured cooldown', () => {
    cooldown.tryClaim(1, 'viewer', 10);
    vi.advanceTimersByTime(10_000);
    expect(cooldown.tryClaim(1, 'viewer', 10)).toBe(true);
  });

  it('does not share state with a separately created cooldown', () => {
    cooldown.tryClaim(1, 'viewer', 60);
    expect(createPerViewerCooldown().tryClaim(1, 'viewer', 60)).toBe(true);
  });
});

describe('getRemainingSeconds', () => {
  it('returns 0 for a pair that has never claimed the cooldown', () => {
    expect(cooldown.getRemainingSeconds(1, 'viewer', 60)).toBe(0);
  });

  it('returns the whole seconds remaining, rounded up, right after a claim', () => {
    cooldown.tryClaim(1, 'viewer', 60);
    vi.advanceTimersByTime(17_400); // 17.4s elapsed => 42.6s remaining
    expect(cooldown.getRemainingSeconds(1, 'viewer', 60)).toBe(43);
  });

  it('returns 0 once the cooldown has fully elapsed', () => {
    cooldown.tryClaim(1, 'viewer', 60);
    vi.advanceTimersByTime(60_000);
    expect(cooldown.getRemainingSeconds(1, 'viewer', 60)).toBe(0);
  });

  it('does not itself claim the cooldown', () => {
    cooldown.tryClaim(1, 'viewer', 60);
    cooldown.getRemainingSeconds(1, 'viewer', 60);
    expect(cooldown.tryClaim(1, 'viewer', 60)).toBe(false);
  });
});

describe('clear', () => {
  it('forgets every recorded claim', () => {
    cooldown.tryClaim(1, 'viewer', 60);
    cooldown.clear();
    expect(cooldown.tryClaim(1, 'viewer', 60)).toBe(true);
  });
});

describe('pruning stale claims (#1005)', () => {
  it('keeps working past the sweep threshold: old claims are swept, a claim still on cooldown still blocks', () => {
    const start = Date.UTC(2026, 10, 13);
    vi.setSystemTime(start);
    expect(cooldown.tryClaim(1, 'still-cooling', 3600)).toBe(true);
    vi.setSystemTime(start + 10 * 60_000);
    // A thousand-odd viewers chat with a 60s cooldown; their claims expire long before the next sweep.
    for (let i = 0; i < 1100; i++) expect(cooldown.tryClaim(1, `viewer${i}`, 60)).toBe(true);
    vi.setSystemTime(start + 20 * 60_000);
    expect(cooldown.tryClaim(1, 'sweeper', 60)).toBe(true);

    // The one-hour claim is still within the longest cooldown seen, so it survived and still blocks.
    expect(cooldown.tryClaim(1, 'still-cooling', 3600)).toBe(false);
    expect(cooldown.getRemainingSeconds(1, 'still-cooling', 3600)).toBe(40 * 60);
    // A swept viewer can claim again.
    expect(cooldown.tryClaim(1, 'viewer0', 60)).toBe(true);
  });
});
