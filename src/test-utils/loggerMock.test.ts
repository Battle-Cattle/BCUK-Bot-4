import { describe, it, expect, vi } from 'vitest';
import { mockLogger } from './loggerMock';

describe('mockLogger', () => {
  it('returns a fresh set of vi.fn()s matching the real logger shape', () => {
    const logger = mockLogger();
    expect(vi.isMockFunction(logger.info)).toBe(true);
    expect(vi.isMockFunction(logger.warn)).toBe(true);
    expect(vi.isMockFunction(logger.error)).toBe(true);
    expect(vi.isMockFunction(logger.debug)).toBe(true);
  });

  it('returns independent instances across calls', () => {
    const a = mockLogger();
    const b = mockLogger();
    a.info('x');
    expect(b.info).not.toHaveBeenCalled();
  });
});
