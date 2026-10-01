import { describe, it, expect } from 'vitest';
import { isTimerSelfManageableBy, isTimerUnclaimedBy } from './timerSelfService';

const SELF = '111111111111111111';
const OTHER = '222222222222222222';

describe('isTimerSelfManageableBy', () => {
  it('is true for a timer assigned to the streamer alone', () => {
    expect(isTimerSelfManageableBy([SELF], SELF)).toBe(true);
  });

  it('is false when the timer is shared, belongs to someone else, or has no assignees', () => {
    expect(isTimerSelfManageableBy([SELF, OTHER], SELF)).toBe(false);
    expect(isTimerSelfManageableBy([OTHER], SELF)).toBe(false);
    expect(isTimerSelfManageableBy([], SELF)).toBe(false);
  });
});

describe('isTimerUnclaimedBy', () => {
  it('is true with no assignees or only the creator', () => {
    expect(isTimerUnclaimedBy([], SELF)).toBe(true);
    expect(isTimerUnclaimedBy([SELF], SELF)).toBe(true);
  });

  it('is false once anyone else is assigned', () => {
    expect(isTimerUnclaimedBy([SELF, OTHER], SELF)).toBe(false);
    expect(isTimerUnclaimedBy([OTHER], SELF)).toBe(false);
  });
});
