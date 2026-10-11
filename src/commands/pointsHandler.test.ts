import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../db', () => ({
  getLoyaltyPointsBalance: vi.fn(),
  getLoyaltyPointsLeaderboard: vi.fn(),
}));
// Shared so a test can assert on the error logged by pointsHandler.ts's module-level `log`
// instance (created once via `createLogger('Points')` at import time).
const { logErrorSpy } = vi.hoisted(() => ({ logErrorSpy: vi.fn() }));
vi.mock('../shared/logger', () => ({ createLogger: () => ({ info: vi.fn(), error: logErrorSpy }) }));

import { getLoyaltyPointsBalance, getLoyaltyPointsLeaderboard } from '../db';
import { executePointsCommandForTwitch, registerPointsTwitchRuntime } from './pointsHandler';

const SEND = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
  SEND.mockResolvedValue(undefined);
  registerPointsTwitchRuntime({ send: SEND });
  vi.mocked(getLoyaltyPointsBalance).mockResolvedValue(0);
  vi.mocked(getLoyaltyPointsLeaderboard).mockResolvedValue([]);
});

describe('executePointsCommandForTwitch', () => {
  it('ignores a message that is not the !points command', async () => {
    await executePointsCommandForTwitch('channel', 1, 'hello', 'alice', 'hello');
    expect(SEND).not.toHaveBeenCalled();
  });

  it('no-ops when streamerId is null (channel has no linked streamer)', async () => {
    await executePointsCommandForTwitch('channel', null, '!points', 'alice', '!points');
    expect(SEND).not.toHaveBeenCalled();
  });

  it('no-ops when there is no username', async () => {
    await executePointsCommandForTwitch('channel', 1, '!points', null, '!points');
    expect(SEND).not.toHaveBeenCalled();
  });

  it('sends the caller\'s balance for bare !points', async () => {
    vi.mocked(getLoyaltyPointsBalance).mockResolvedValue(42);
    await executePointsCommandForTwitch('channel', 1, '!points', 'alice', '!points');
    expect(getLoyaltyPointsBalance).toHaveBeenCalledWith(1, 'alice');
    expect(SEND).toHaveBeenCalledWith('channel', '@alice has 42 points.');
  });

  it('uses singular "point" for a balance of exactly 1', async () => {
    vi.mocked(getLoyaltyPointsBalance).mockResolvedValue(1);
    await executePointsCommandForTwitch('channel', 1, '!points', 'alice', '!points');
    expect(SEND).toHaveBeenCalledWith('channel', '@alice has 1 point.');
  });

  it('sends the caller\'s balance for "!points balance"', async () => {
    vi.mocked(getLoyaltyPointsBalance).mockResolvedValue(10);
    await executePointsCommandForTwitch('channel', 1, '!points balance', 'alice', '!points');
    expect(SEND).toHaveBeenCalledWith('channel', '@alice has 10 points.');
  });

  it('sends the leaderboard for "!points leaderboard"', async () => {
    vi.mocked(getLoyaltyPointsLeaderboard).mockResolvedValue([
      { twitchUsername: 'top', balance: 500 },
      { twitchUsername: 'second', balance: 100 },
    ]);
    await executePointsCommandForTwitch('channel', 1, '!points leaderboard', 'alice', '!points');
    expect(getLoyaltyPointsLeaderboard).toHaveBeenCalledWith(1, 5);
    expect(SEND).toHaveBeenCalledWith('channel', '1. top (500), 2. second (100)');
  });

  it('accepts the "top" alias for the leaderboard', async () => {
    vi.mocked(getLoyaltyPointsLeaderboard).mockResolvedValue([{ twitchUsername: 'top', balance: 1 }]);
    await executePointsCommandForTwitch('channel', 1, '!points top', 'alice', '!points');
    expect(getLoyaltyPointsLeaderboard).toHaveBeenCalledOnce();
  });

  it('is case-insensitive when matching the leaderboard subcommand', async () => {
    vi.mocked(getLoyaltyPointsLeaderboard).mockResolvedValue([{ twitchUsername: 'top', balance: 1 }]);
    await executePointsCommandForTwitch('channel', 1, '!points LEADERBOARD', 'alice', '!points');
    expect(getLoyaltyPointsLeaderboard).toHaveBeenCalledOnce();
  });

  it('reports an empty leaderboard', async () => {
    await executePointsCommandForTwitch('channel', 1, '!points leaderboard', 'alice', '!points');
    expect(SEND).toHaveBeenCalledWith('channel', 'No one has earned any points yet.');
  });

  it('falls back to the balance response for an unrecognized subcommand', async () => {
    vi.mocked(getLoyaltyPointsBalance).mockResolvedValue(3);
    await executePointsCommandForTwitch('channel', 1, '!points something', 'alice', '!points');
    expect(SEND).toHaveBeenCalledWith('channel', '@alice has 3 points.');
  });

  it('logs rather than throws when sending the response fails', async () => {
    const sendError = new Error('send failed');
    SEND.mockRejectedValue(sendError);

    await expect(executePointsCommandForTwitch('channel', 1, '!points', 'alice', '!points')).resolves.toBeUndefined();

    expect(logErrorSpy).toHaveBeenCalledWith(expect.stringContaining('Failed to send points response'), sendError);
  });
});
