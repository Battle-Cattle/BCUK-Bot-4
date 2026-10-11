import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../db', () => ({
  getLoyaltyPointsBalance: vi.fn(),
  adjustLoyaltyPointsBalance: vi.fn(),
  tryDebitLoyaltyPointsBalance: vi.fn(),
  getLoyaltyPointsConfig: vi.fn(),
  DEFAULT_POINTS_COOLDOWN_SECONDS: 60,
}));
vi.mock('./pointsEarnHandler', () => ({ tryClaimPointsCooldown: vi.fn() }));

// Shared so a test can assert on the error logged by gambleHandler.ts's module-level `log`
// instance (created once via `createLogger('Gamble')` at import time).
const { logErrorSpy } = vi.hoisted(() => ({ logErrorSpy: vi.fn() }));
vi.mock('../shared/logger', () => ({ createLogger: () => ({ info: vi.fn(), error: logErrorSpy }) }));

import { getLoyaltyPointsBalance, adjustLoyaltyPointsBalance, tryDebitLoyaltyPointsBalance, getLoyaltyPointsConfig } from '../db';
import { tryClaimPointsCooldown } from './pointsEarnHandler';
import { executeGambleCommandForTwitch, registerGambleTwitchRuntime } from './gambleHandler';

const SEND = vi.fn();
let randomSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.clearAllMocks();
  SEND.mockResolvedValue(undefined);
  registerGambleTwitchRuntime({ send: SEND });
  vi.mocked(getLoyaltyPointsBalance).mockResolvedValue(1000);
  vi.mocked(tryDebitLoyaltyPointsBalance).mockResolvedValue(900);
  vi.mocked(adjustLoyaltyPointsBalance).mockResolvedValue(0);
  vi.mocked(getLoyaltyPointsConfig).mockResolvedValue(null);
  vi.mocked(tryClaimPointsCooldown).mockReturnValue(true);
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

  it('sends a usage reply for an invalid amount, without consuming the cooldown', async () => {
    await executeGambleCommandForTwitch('channel', 1, '!gamble abc', 'alice', '!gamble');
    expect(SEND).toHaveBeenCalledWith('channel', expect.stringContaining('Usage: !gamble'));
    expect(tryClaimPointsCooldown).not.toHaveBeenCalled();
    expect(tryDebitLoyaltyPointsBalance).not.toHaveBeenCalled();
  });

  it('sends a usage reply for an amount above the caller\'s balance', async () => {
    vi.mocked(getLoyaltyPointsBalance).mockResolvedValue(50);
    await executeGambleCommandForTwitch('channel', 1, '!gamble 100', 'alice', '!gamble');
    expect(SEND).toHaveBeenCalledWith('channel', expect.stringContaining('Usage: !gamble'));
  });

  it('does not gamble when the cooldown is active', async () => {
    vi.mocked(tryClaimPointsCooldown).mockReturnValue(false);
    await executeGambleCommandForTwitch('channel', 1, '!gamble 100', 'alice', '!gamble');
    expect(SEND).not.toHaveBeenCalled();
    expect(tryDebitLoyaltyPointsBalance).not.toHaveBeenCalled();
  });

  it('uses the streamer\'s configured cooldown', async () => {
    vi.mocked(getLoyaltyPointsConfig).mockResolvedValue({ pointsPerMessage: 1, cooldownSeconds: 15, pointsPerSub: 100, pointsPerGiftSub: 100 });
    await executeGambleCommandForTwitch('channel', 1, '!gamble 100', 'alice', '!gamble');
    expect(tryClaimPointsCooldown).toHaveBeenCalledWith(1, 'alice', 15);
  });

  it('falls back to the default cooldown when unconfigured', async () => {
    await executeGambleCommandForTwitch('channel', 1, '!gamble 100', 'alice', '!gamble');
    expect(tryClaimPointsCooldown).toHaveBeenCalledWith(1, 'alice', 60);
  });

  it('debits the stake atomically before flipping the coin', async () => {
    await executeGambleCommandForTwitch('channel', 1, '!gamble 100', 'alice', '!gamble');
    expect(tryDebitLoyaltyPointsBalance).toHaveBeenCalledWith(1, 'alice', 100);
  });

  it('credits back double the stake on a win (returned stake plus profit)', async () => {
    randomSpy.mockReturnValue(0); // < 0.5 => win
    vi.mocked(tryDebitLoyaltyPointsBalance).mockResolvedValue(900);
    vi.mocked(adjustLoyaltyPointsBalance).mockResolvedValue(1100);

    await executeGambleCommandForTwitch('channel', 1, '!gamble 100', 'alice', '!gamble');

    expect(adjustLoyaltyPointsBalance).toHaveBeenCalledWith(1, 'alice', 200);
    expect(SEND).toHaveBeenCalledWith('channel', '@alice won 100 points! New balance: 1100');
  });

  it('makes no further write on a loss — the stake is already debited', async () => {
    randomSpy.mockReturnValue(0.99); // >= 0.5 => loss
    vi.mocked(tryDebitLoyaltyPointsBalance).mockResolvedValue(900);

    await executeGambleCommandForTwitch('channel', 1, '!gamble 100', 'alice', '!gamble');

    expect(adjustLoyaltyPointsBalance).not.toHaveBeenCalled();
    expect(SEND).toHaveBeenCalledWith('channel', '@alice lost 100 points. New balance: 900');
  });

  it('sends a balance-changed reply when the atomic debit fails (lost a race)', async () => {
    vi.mocked(tryDebitLoyaltyPointsBalance).mockResolvedValue(null);

    await executeGambleCommandForTwitch('channel', 1, '!gamble 100', 'alice', '!gamble');

    expect(adjustLoyaltyPointsBalance).not.toHaveBeenCalled();
    expect(SEND).toHaveBeenCalledWith('channel', expect.stringContaining('balance changed'));
  });

  it('resolves "all" against the caller\'s current balance', async () => {
    vi.mocked(getLoyaltyPointsBalance).mockResolvedValue(250);
    randomSpy.mockReturnValue(0.99); // loss, so no credit call to assert around

    await executeGambleCommandForTwitch('channel', 1, '!gamble all', 'alice', '!gamble');

    expect(tryDebitLoyaltyPointsBalance).toHaveBeenCalledWith(1, 'alice', 250);
  });

  it('resolves a percentage against the caller\'s current balance', async () => {
    vi.mocked(getLoyaltyPointsBalance).mockResolvedValue(200);
    randomSpy.mockReturnValue(0.99); // loss, so no credit call to assert around

    await executeGambleCommandForTwitch('channel', 1, '!gamble 40%', 'alice', '!gamble');

    expect(tryDebitLoyaltyPointsBalance).toHaveBeenCalledWith(1, 'alice', 80);
  });

  it('logs rather than throws when sending the result fails', async () => {
    randomSpy.mockReturnValue(0.99);
    const sendError = new Error('send failed');
    SEND.mockRejectedValue(sendError);

    await expect(executeGambleCommandForTwitch('channel', 1, '!gamble 100', 'alice', '!gamble')).resolves.toBeUndefined();

    expect(logErrorSpy).toHaveBeenCalledWith(expect.stringContaining('Failed to send gamble result'), sendError);
  });
});
