import { describe, it, expect, vi } from 'vitest';

vi.mock('../../db', () => ({
  ALERT_EVENT_TYPES: ['follow', 'sub', 'resub', 'giftsub', 'raid'],
}));

import { parseEventType, parseEnumField } from './alertsShared';

describe('parseEventType', () => {
  it('returns the value when it is a known event type', () => {
    expect(parseEventType('raid')).toBe('raid');
  });

  it('returns null for an unknown event type', () => {
    expect(parseEventType('bogus')).toBeNull();
  });

  it('returns null for a repeated field arriving as an array', () => {
    expect(parseEventType(['follow', 'sub'])).toBeNull();
  });
});

describe('parseEnumField', () => {
  const ANIMALS = ['cat', 'dog', 'bird'] as const;

  it('returns the value when it is in the allowed list', () => {
    expect(parseEnumField('dog', ANIMALS)).toBe('dog');
  });

  it('returns null by default when the value is not in the allowed list', () => {
    expect(parseEnumField('fish', ANIMALS)).toBeNull();
  });

  it('returns the given fallback when the value is not in the allowed list', () => {
    expect(parseEnumField('fish', ANIMALS, 'cat')).toBe('cat');
  });

  it('returns the fallback for a non-string value (e.g. an array from a repeated field)', () => {
    expect(parseEnumField(['dog', 'cat'], ANIMALS, 'cat')).toBe('cat');
  });

  it('returns the fallback for undefined', () => {
    expect(parseEnumField(undefined, ANIMALS, 'cat')).toBe('cat');
  });
});
