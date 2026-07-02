import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../db', () => ({
  getStreamerByDiscordId: vi.fn(),
}));
vi.mock('../../shared/logger', () => ({
  createLogger: () => ({ warn: vi.fn(), error: vi.fn(), info: vi.fn() }),
}));

import { getStreamerByDiscordId } from '../../db';
import { requireStreamer, toStringArray, parseWeight } from './overlayAdminShared';
import type { Request, Response } from 'express';

function makeReq(discordId: string): Request {
  return {
    session: { user: { discordId } },
  } as unknown as Request;
}

function makeRes() {
  const redirect = vi.fn();
  return { res: { redirect } as unknown as Response, redirect };
}

// ─── requireStreamer ──────────────────────────────────────────────────────────

describe('requireStreamer', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns the streamer when found', async () => {
    const streamer = { id: 1, twitch_name: 'mystreamer' };
    vi.mocked(getStreamerByDiscordId).mockResolvedValue(streamer as any);
    const req = makeReq('100000000000000001');
    const { res } = makeRes();
    const result = await requireStreamer(req, res);
    expect(result).toBe(streamer);
  });

  it('redirects and returns null when streamer is not found', async () => {
    vi.mocked(getStreamerByDiscordId).mockResolvedValue(null);
    const req = makeReq('100000000000000001');
    const { res, redirect } = makeRes();
    const result = await requireStreamer(req, res);
    expect(result).toBeNull();
    expect(redirect).toHaveBeenCalledWith('/overlay/settings?error=not_a_streamer');
  });

  it('calls getStreamerByDiscordId with the session user\'s discordId', async () => {
    vi.mocked(getStreamerByDiscordId).mockResolvedValue(null);
    const req = makeReq('200000000000000002');
    const { res } = makeRes();
    await requireStreamer(req, res);
    expect(getStreamerByDiscordId).toHaveBeenCalledWith('200000000000000002');
  });
});

// ─── toStringArray ────────────────────────────────────────────────────────────

describe('toStringArray', () => {
  it('returns the array unchanged when given an array', () => {
    expect(toStringArray(['a', 'b', 'c'])).toEqual(['a', 'b', 'c']);
  });

  it('wraps a string in a single-element array', () => {
    expect(toStringArray('hello')).toEqual(['hello']);
  });

  it('returns an empty array for undefined', () => {
    expect(toStringArray(undefined)).toEqual([]);
  });

  it('returns an empty array for an empty string', () => {
    expect(toStringArray('')).toEqual([]);
  });

  it('preserves an empty array input', () => {
    expect(toStringArray([])).toEqual([]);
  });
});

// ─── parseWeight ─────────────────────────────────────────────────────────────

describe('parseWeight', () => {
  it('returns null for undefined', () => {
    expect(parseWeight(undefined)).toBeNull();
  });

  it('returns null for a non-numeric string', () => {
    expect(parseWeight('abc')).toBeNull();
  });

  it('returns null for zero', () => {
    expect(parseWeight('0')).toBeNull();
  });

  it('returns null for a negative number', () => {
    expect(parseWeight('-5')).toBeNull();
  });

  it('returns the parsed integer for a valid positive number', () => {
    expect(parseWeight('10')).toBe(10);
  });

  it('floors a float string', () => {
    expect(parseWeight('3.9')).toBe(3);
  });

  it('floors a float close to the next integer', () => {
    expect(parseWeight('2.99')).toBe(2);
  });

  it('returns null for an array (repeated field)', () => {
    expect(parseWeight(['7', '99'])).toBeNull();
  });

  it('returns null for an array with a non-numeric first element', () => {
    expect(parseWeight(['abc'])).toBeNull();
  });

  it('returns null for an empty array', () => {
    expect(parseWeight([])).toBeNull();
  });

  it('returns null for Infinity (not finite)', () => {
    expect(parseWeight('Infinity')).toBeNull();
  });

  it('returns null for a single-element array (repeated field)', () => {
    expect(parseWeight(['7'])).toBeNull();
  });
});
