import { describe, it, expect } from 'vitest';
import {
  hasRequiredRole, computeCommandCost, createAdvancedCommandCooldowns, describeActiveCooldowns, createNoticeThrottle, type ChatRoleInfo,
} from './advancedCommandGates';

const NONE: ChatRoleInfo = { isBroadcaster: false, isMod: false, isVip: false, isSubscriber: false };

describe('hasRequiredRole', () => {
  it.each([
    ['everyone', NONE, true],
    ['subscriber', NONE, false],
    ['subscriber', { ...NONE, isSubscriber: true }, true],
    ['subscriber', { ...NONE, isVip: true }, true],
    ['vip', { ...NONE, isSubscriber: true }, false],
    ['vip', { ...NONE, isMod: true }, true],
    ['moderator', { ...NONE, isVip: true }, false],
    ['moderator', { ...NONE, isMod: true }, true],
    ['moderator', { ...NONE, isBroadcaster: true }, true],
  ] as const)('%s with %o → %s', (role, info, expected) => {
    expect(hasRequiredRole(role, info)).toBe(expected);
  });
});

describe('computeCommandCost', () => {
  it('adds the price step per earlier use and caps at max cost', () => {
    const command = { pointCost: 100, priceStep: 25, maxCost: 150 };
    expect(computeCommandCost(command, 0)).toBe(100);
    expect(computeCommandCost(command, 1)).toBe(125);
    expect(computeCommandCost(command, 5)).toBe(150);
    expect(computeCommandCost({ ...command, maxCost: null }, 5)).toBe(225);
  });
});

describe('createAdvancedCommandCooldowns', () => {
  const command = { id: 1, globalCooldownSeconds: 10, userCooldownSeconds: 60 };

  it('reports the longer of the global and per-viewer cooldowns', () => {
    const cooldowns = createAdvancedCommandCooldowns();
    expect(cooldowns.remaining(command, 'alice', 0)).toEqual({ globalSeconds: 0, userSeconds: 0 });
    cooldowns.claim(command, 'alice', 0);
    expect(cooldowns.remaining(command, 'alice', 5_000)).toEqual({ globalSeconds: 5, userSeconds: 55 });
    expect(cooldowns.remaining(command, 'bob', 5_000)).toEqual({ globalSeconds: 5, userSeconds: 0 });
    expect(cooldowns.remaining(command, 'bob', 10_000)).toEqual({ globalSeconds: 0, userSeconds: 0 });
    expect(cooldowns.remaining(command, 'alice', 60_000)).toEqual({ globalSeconds: 0, userSeconds: 0 });
  });

  it('ignores zero cooldowns and forgets everything on clear', () => {
    const cooldowns = createAdvancedCommandCooldowns();
    const none = { id: 2, globalCooldownSeconds: 0, userCooldownSeconds: 0 };
    cooldowns.claim(none, 'alice', 0);
    expect(cooldowns.remaining(none, 'alice', 0)).toEqual({ globalSeconds: 0, userSeconds: 0 });
    cooldowns.claim(command, 'alice', 0);
    cooldowns.clear();
    expect(cooldowns.remaining(command, 'alice', 1)).toEqual({ globalSeconds: 0, userSeconds: 0 });
  });
});

describe('describeActiveCooldowns', () => {
  it('lists each active cooldown, or null when none is', () => {
    expect(describeActiveCooldowns({ globalSeconds: 25, userSeconds: 110 })).toBe('global cooldown 25s, your cooldown 110s');
    expect(describeActiveCooldowns({ globalSeconds: 25, userSeconds: 0 })).toBe('global cooldown 25s');
    expect(describeActiveCooldowns({ globalSeconds: 0, userSeconds: 110 })).toBe('your cooldown 110s');
    expect(describeActiveCooldowns({ globalSeconds: 0, userSeconds: 0 })).toBeNull();
  });
});

describe('createNoticeThrottle', () => {
  it('allows one notice per key per window', () => {
    const throttle = createNoticeThrottle(1000);
    expect(throttle.tryClaim('a', 0)).toBe(true);
    expect(throttle.tryClaim('a', 500)).toBe(false);
    expect(throttle.tryClaim('b', 500)).toBe(true);
    expect(throttle.tryClaim('a', 1000)).toBe(true);
    throttle.clear();
    expect(throttle.tryClaim('a', 1001)).toBe(true);
  });

  it('prunes stale entries once it grows large', () => {
    const throttle = createNoticeThrottle(10);
    for (let i = 0; i <= 1000; i++) throttle.tryClaim(`k${i}`, 0);
    expect(throttle.tryClaim('fresh', 100)).toBe(true);
    // k0 was pruned as stale, so it can be claimed again at once.
    expect(throttle.tryClaim('k0', 100)).toBe(true);
  });
});
