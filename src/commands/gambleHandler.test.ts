import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../db', () => ({
  getLoyaltyPointsBalance: vi.fn(),
  resolveLoyaltyPointsGambleOutcome: vi.fn(),
  getLoyaltyPointsConfig: vi.fn(),
}));
vi.mock('./pointsEarnHandler', () => ({ tryClaimPointsCooldown: vi.fn(), getRemainingCooldownSeconds: vi.fn() }));

// Shared so a test can assert on the error logged by gambleHandler.ts's module-level `log`
// instance (created once via `createLogger('Gamble')` at import time).
const { logErrorSpy } = vi.hoisted(() => ({ logErrorSpy: vi.fn() }));
vi.mock('../shared/logger', () => ({ createLogger: () => ({ info: vi.fn(), error: logErrorSpy }) }));

import { getLoyaltyPointsBalance, resolveLoyaltyPointsGambleOutcome, getLoyaltyPointsConfig } from '../db';
import { tryClaimPointsCooldown, getRemainingCooldownSeconds } from './pointsEarnHandler';
import { executeGambleCommandForTwitch, registerGambleTwitchRuntime } from './gambleHandler';

const SEND = vi.fn();
let randomSpy: ReturnType<typeof vi.spyOn>;
const ENABLED_CONFIG = { enabled: true, pointsPerMessage: 1, cooldownSeconds: 60, pointsPerSub: 100, pointsPerGiftSub: 100 };

beforeEach(() => {
  vi.clearAllMocks();
  SEND.mockResolvedValue(undefined);
  registerGambleTwitchRuntime({ send: SEND });
  vi.mocked(getLoyaltyPointsBalance).mockResolvedValue(1000);
  vi.mocked(resolveLoyaltyPointsGambleOutcome).mockResolvedValue(900);
  vi.mocked(getLoyaltyPointsConfig).mockResolvedValue(ENABLED_CONFIG);
  vi.mocked(tryClaimPointsCooldown).mockReturnValue(true);
  vi.mocked(getRemainingCooldownSeconds).mockReturnValue(42);
  randomSpy = vi.spyOn(Math, 'random');
});

describe('executeGambleCommandForTwitch', () => {
  it('ignores a message that is not the !gamble command', async () => {
    await executeGambleCommandForTwitch('channel', 1, 'hello', 'alice', 'hello');
    expect(SEND).not.toHaveBeenCalled();
  });

  it('no-ops when streamerId is null (channel has no linked streamer)', async () => {
    await executeGambleCommandForTwitch('channel', null, '!gamble 100', 'alice', '!gamble');
    expect(SEND).not.toHaveBeenCalled();
  });

  it('no-ops when there is no username', async () => {
    await executeGambleCommandForTwitch('channel', 1, '!gamble 100', null, '!gamble');
    expect(SEND).not.toHaveBeenCalled();
  });

  it('no-ops when the streamer has not opted into Loyalty Points (no config row)', async () => {
    vi.mocked(getLoyaltyPointsConfig).mockResolvedValue(null);
    await executeGambleCommandForTwitch('channel', 1, '!gamble 100', 'alice', '!gamble');
    expect(SEND).not.toHaveBeenCalled();
    expect(resolveLoyaltyPointsGambleOutcome).not.toHaveBeenCalled();
  });

  it('no-ops when the streamer has a config row but enabled is false', async () => {
    vi.mocked(getLoyaltyPointsConfig).mockResolvedValue({ ...ENABLED_CONFIG, enabled: false });
    await executeGambleCommandForTwitch('channel', 1, '!gamble 100', 'alice', '!gamble');
    expect(SEND).not.toHaveBeenCalled();
  });

  it('sends a usage reply for an invalid amount, without consuming the cooldown', async () => {
    await executeGambleCommandForTwitch('channel', 1, '!gamble abc', 'alice', '!gamble');
    expect(SEND).toHaveBeenCalledWith('channel', expect.stringContaining('Usage: !gamble'));
    expect(tryClaimPointsCooldown).not.toHaveBeenCalled();
    expect(resolveLoyaltyPointsGambleOutcome).not.toHaveBeenCalled();
  });

  it('sends a usage reply for an amount above the caller\'s balance', async () => {
    vi.mocked(getLoyaltyPointsBalance).mockResolvedValue(50);
    await executeGambleCommandForTwitch('channel', 1, '!gamble 100', 'alice', '!gamble');
    expect(SEND).toHaveBeenCalledWith('channel', expect.stringContaining('Usage: !gamble'));
  });

  it('does not gamble when the cooldown is active, and replies with the remaining time', async () => {
    vi.mocked(tryClaimPointsCooldown).mockReturnValue(false);
    vi.mocked(getRemainingCooldownSeconds).mockReturnValue(42);
    await executeGambleCommandForTwitch('channel', 1, '!gamble 100', 'alice', '!gamble');
    expect(resolveLoyaltyPointsGambleOutcome).not.toHaveBeenCalled();
    expect(getRemainingCooldownSeconds).toHaveBeenCalledWith(1, 'alice', 60);
    expect(SEND).toHaveBeenCalledWith('channel', '@alice still on cooldown — try again in 42s.');
  });

  it('uses the streamer\'s configured cooldown', async () => {
    vi.mocked(getLoyaltyPointsConfig).mockResolvedValue({ enabled: true, pointsPerMessage: 1, cooldownSeconds: 15, pointsPerSub: 100, pointsPerGiftSub: 100 });
    await executeGambleCommandForTwitch('channel', 1, '!gamble 100', 'alice', '!gamble');
    expect(tryClaimPointsCooldown).toHaveBeenCalledWith(1, 'alice', 15);
  });

  it('resolves the stake debit and outcome atomically in one call', async () => {
    randomSpy.mockReturnValue(0.99); // loss
    await executeGambleCommandForTwitch('channel', 1, '!gamble 100', 'alice', '!gamble');
    expect(resolveLoyaltyPointsGambleOutcome).toHaveBeenCalledWith(1, 'alice', 100, false);
  });

  it('reports a win with the coin flip\'s outcome and the atomically-credited new balance', async () => {
    randomSpy.mockReturnValue(0); // < 0.5 => win
    vi.mocked(resolveLoyaltyPointsGambleOutcome).mockResolvedValue(1100);

    await executeGambleCommandForTwitch('channel', 1, '!gamble 100', 'alice', '!gamble');

    expect(resolveLoyaltyPointsGambleOutcome).toHaveBeenCalledWith(1, 'alice', 100, true);
    expect(SEND).toHaveBeenCalledWith('channel', '@alice won 100 points! New balance: 1100');
  });

  it('reports a loss with the atomically-debited new balance', async () => {
    randomSpy.mockReturnValue(0.99); // >= 0.5 => loss
    vi.mocked(resolveLoyaltyPointsGambleOutcome).mockResolvedValue(900);

    await executeGambleCommandForTwitch('channel', 1, '!gamble 100', 'alice', '!gamble');

    expect(SEND).toHaveBeenCalledWith('channel', '@alice lost 100 points. New balance: 900');
  });

  it('sends a balance-changed reply when the atomic resolve fails (lost a race)', async () => {
    vi.mocked(resolveLoyaltyPointsGambleOutcome).mockResolvedValue(null);

    await executeGambleCommandForTwitch('channel', 1, '!gamble 100', 'alice', '!gamble');

    expect(SEND).toHaveBeenCalledWith('channel', expect.stringContaining('balance changed'));
  });

  it('resolves "all" against the caller\'s current balance', async () => {
    vi.mocked(getLoyaltyPointsBalance).mockResolvedValue(250);
    randomSpy.mockReturnValue(0.99); // loss

    await executeGambleCommandForTwitch('channel', 1, '!gamble all', 'alice', '!gamble');

    expect(resolveLoyaltyPointsGambleOutcome).toHaveBeenCalledWith(1, 'alice', 250, false);
  });

  it('resolves a percentage against the caller\'s current balance', async () => {
    vi.mocked(getLoyaltyPointsBalance).mockResolvedValue(200);
    randomSpy.mockReturnValue(0.99); // loss

    await executeGambleCommandForTwitch('channel', 1, '!gamble 40%', 'alice', '!gamble');

    expect(resolveLoyaltyPointsGambleOutcome).toHaveBeenCalledWith(1, 'alice', 80, false);
  });

  it('logs rather than throws when sending the result fails', async () => {
    randomSpy.mockReturnValue(0.99);
    const sendError = new Error('send failed');
    SEND.mockRejectedValue(sendError);

    await expect(executeGambleCommandForTwitch('channel', 1, '!gamble 100', 'alice', '!gamble')).resolves.toBeUndefined();

    expect(logErrorSpy).toHaveBeenCalledWith(expect.stringContaining('Failed to send gamble result'), sendError);
  });
});
