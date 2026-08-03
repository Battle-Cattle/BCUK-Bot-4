import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../shared/config', () => ({ GLOBAL_COOLDOWN_MS: 3_000 }));

import { createCooldownGate } from './cooldownGate';

const COOLDOWN_MS = 3_000;
let mockNow = 1_000_000_000_000;

beforeEach(() => {
  mockNow = 1_000_000_000_000;
  vi.spyOn(Date, 'now').mockImplementation(() => mockNow);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('createCooldownGate', () => {
  it('allows the first claim for a key', () => {
    const gate = createCooldownGate();
    expect(gate.tryClaim('a')).toBe(true);
  });

  it('blocks a second claim for the same key within the cooldown window', () => {
    const gate = createCooldownGate();
    expect(gate.tryClaim('a')).toBe(true);
    mockNow += COOLDOWN_MS - 1;
    expect(gate.tryClaim('a')).toBe(false);
  });

  it('allows a claim again once the cooldown window has elapsed', () => {
    const gate = createCooldownGate();
    expect(gate.tryClaim('a')).toBe(true);
    mockNow += COOLDOWN_MS;
    expect(gate.tryClaim('a')).toBe(true);
  });

  it('does not move the recorded claim time when a claim is blocked', () => {
    const gate = createCooldownGate();
    expect(gate.tryClaim('a')).toBe(true);
    mockNow += COOLDOWN_MS - 1;
    expect(gate.tryClaim('a')).toBe(false);
    mockNow += 1;
    expect(gate.tryClaim('a')).toBe(true);
  });

  it('tracks keys independently', () => {
    const gate = createCooldownGate();
    expect(gate.tryClaim('a')).toBe(true);
    expect(gate.tryClaim('b')).toBe(true);
    expect(gate.tryClaim('a')).toBe(false);
  });

  it('forget clears a key so the next claim succeeds immediately', () => {
    const gate = createCooldownGate();
    expect(gate.tryClaim('a')).toBe(true);
    gate.forget('a');
    expect(gate.tryClaim('a')).toBe(true);
  });

  it('forget is a no-op for a key with no recorded claim', () => {
    const gate = createCooldownGate();
    expect(() => gate.forget('never-claimed')).not.toThrow();
  });
});
