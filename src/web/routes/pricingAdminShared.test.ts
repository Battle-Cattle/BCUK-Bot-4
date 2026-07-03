import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../db', () => ({ getStreamerByDiscordId: vi.fn() }));

import { getStreamerByDiscordId } from '../../db';
import {
  requireStreamer, parsePositiveIntField, parseNonNegativeNumberField, parsePositiveNumberField,
} from './pricingAdminShared';

beforeEach(() => {
  vi.clearAllMocks();
});

describe('requireStreamer', () => {
  function makeReqRes(discordId = '123') {
    const req = { session: { user: { discordId } } } as any;
    const res = { redirect: vi.fn() } as any;
    return { req, res };
  }

  it('returns the streamer when found', async () => {
    const streamer = { id: 1 };
    vi.mocked(getStreamerByDiscordId).mockResolvedValue(streamer as any);
    const { req, res } = makeReqRes();
    const result = await requireStreamer(req, res);
    expect(result).toBe(streamer);
    expect(res.redirect).not.toHaveBeenCalled();
  });

  it('redirects to /pricing?error=not_a_streamer and returns null when not found', async () => {
    vi.mocked(getStreamerByDiscordId).mockResolvedValue(null);
    const { req, res } = makeReqRes();
    const result = await requireStreamer(req, res);
    expect(result).toBeNull();
    expect(res.redirect).toHaveBeenCalledWith('/pricing?error=not_a_streamer');
  });
});

describe('parsePositiveIntField', () => {
  it('accepts a positive integer string', () => {
    expect(parsePositiveIntField('200')).toBe(200);
  });

  it('rejects an array (repeated field)', () => {
    expect(parsePositiveIntField(['1', '2'])).toBeNull();
  });

  it('rejects zero', () => {
    expect(parsePositiveIntField('0')).toBeNull();
  });

  it('rejects non-numeric input', () => {
    expect(parsePositiveIntField('abc')).toBeNull();
  });

  it('rejects a decimal', () => {
    expect(parsePositiveIntField('1.5')).toBeNull();
  });

  it('rejects undefined', () => {
    expect(parsePositiveIntField(undefined)).toBeNull();
  });

  it('rejects an empty string', () => {
    expect(parsePositiveIntField('')).toBeNull();
  });
});

describe('parseNonNegativeNumberField', () => {
  it('accepts zero', () => {
    expect(parseNonNegativeNumberField('0')).toBe(0);
  });

  it('accepts a positive decimal', () => {
    expect(parseNonNegativeNumberField('4.5')).toBe(4.5);
  });

  it('rejects a negative number', () => {
    expect(parseNonNegativeNumberField('-1')).toBeNull();
  });

  it('rejects an array (repeated field)', () => {
    expect(parseNonNegativeNumberField(['1', '2'])).toBeNull();
  });

  it('rejects undefined', () => {
    expect(parseNonNegativeNumberField(undefined)).toBeNull();
  });

  it('rejects an empty string instead of silently coercing to 0', () => {
    expect(parseNonNegativeNumberField('')).toBeNull();
  });

  it('rejects a whitespace-only string instead of silently coercing to 0', () => {
    expect(parseNonNegativeNumberField('   ')).toBeNull();
  });
});

describe('parsePositiveNumberField', () => {
  it('accepts a positive decimal', () => {
    expect(parsePositiveNumberField('1.5')).toBe(1.5);
  });

  it('rejects zero', () => {
    expect(parsePositiveNumberField('0')).toBeNull();
  });

  it('rejects a negative number', () => {
    expect(parsePositiveNumberField('-1')).toBeNull();
  });

  it('rejects an array (repeated field)', () => {
    expect(parsePositiveNumberField(['1', '2'])).toBeNull();
  });

  it('rejects undefined', () => {
    expect(parsePositiveNumberField(undefined)).toBeNull();
  });

  it('rejects an empty string instead of silently coercing to 0', () => {
    expect(parsePositiveNumberField('')).toBeNull();
  });

  it('rejects a whitespace-only string instead of silently coercing to 0', () => {
    expect(parsePositiveNumberField('   ')).toBeNull();
  });
});
