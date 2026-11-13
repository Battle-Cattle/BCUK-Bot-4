import { describe, it, expect } from 'vitest';
import { parseBearerToken } from './bearerToken';

describe('parseBearerToken (#923)', () => {
  it.each(['Bearer abc123', 'bearer abc123', 'BEARER abc123', 'Bearer   abc123  ', '  Bearer abc123'])(
    'reads the token from %j whatever the scheme\'s case or spacing',
    (header) => {
      expect(parseBearerToken(header)).toBe('abc123');
    },
  );

  it.each([undefined, '', 'abc123', 'Basic abc123', 'Bearer', 'Bearer   ', 'Bearertoken', 'Bearer a b'])(
    'returns null for a missing or malformed header (%j)',
    (header) => {
      expect(parseBearerToken(header)).toBeNull();
    },
  );
});
