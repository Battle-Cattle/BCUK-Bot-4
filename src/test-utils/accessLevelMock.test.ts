import { describe, it, expect } from 'vitest';
import { ACCESS_LEVEL_MOCK } from './accessLevelMock';

describe('ACCESS_LEVEL_MOCK', () => {
  it('mirrors the real AccessLevel ladder values from src/db/users.ts', () => {
    expect(ACCESS_LEVEL_MOCK).toEqual({ USER: 0, MOD: 1, MANAGER: 2, ADMIN: 3 });
  });
});
