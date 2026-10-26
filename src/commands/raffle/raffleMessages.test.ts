import { describe, it, expect } from 'vitest';
import {
  buildRaffleAlreadyRunningMessage,
  buildRaffleReminderMessage,
  buildRaffleResultMessage,
  buildRaffleStartMessage,
} from './raffleMessages';

describe('buildRaffleStartMessage', () => {
  it('names the channel, the prize and how to join', () => {
    const msg = buildRaffleStartMessage('streamer', 1000, false);
    expect(msg).toContain('1,000 points');
    expect(msg).toContain("!join here in streamer's chat");
    expect(msg).toContain('60s');
    expect(msg).not.toMatch(/shared chat/i);
  });

  it('warns that shared chat does not count during a shared-chat session', () => {
    expect(buildRaffleStartMessage('streamer', 100, true)).toContain("Entries from shared chat don't count.");
  });
});

describe('buildRaffleReminderMessage', () => {
  it('shows the time left, the channel and the entry count', () => {
    const msg = buildRaffleReminderMessage('streamer', 1000, 45, 2, false);
    expect(msg).toBe("⏰ 45s left in the 1,000-point raffle. Type !join in streamer's own chat to enter. Entries so far: 2.");
  });

  it('adds the shared-chat warning during a shared-chat session', () => {
    expect(buildRaffleReminderMessage('streamer', 100, 15, 0, true)).toContain("(shared chat doesn't count)");
  });
});

describe('buildRaffleAlreadyRunningMessage', () => {
  it('says when the open raffle ends', () => {
    expect(buildRaffleAlreadyRunningMessage(40)).toBe('A raffle is already running. It ends in 40s.');
  });
});

describe('buildRaffleResultMessage', () => {
  it('reports that nobody entered', () => {
    expect(buildRaffleResultMessage(0, [], 0)).toBe('Raffle over. Nobody entered, so no points were given out.');
  });

  it('announces a single winner', () => {
    expect(buildRaffleResultMessage(1, ['alice'], 1000)).toBe('🎉 Raffle over! 1 entry, 1 winner: @alice wins 1,000 points!');
  });

  it('announces two winners', () => {
    expect(buildRaffleResultMessage(5, ['alice', 'bob'], 500))
      .toBe('🎉 Raffle over! 5 entries, 2 winners: @alice and @bob win 500 points each!');
  });

  it('lists three or more winners with commas', () => {
    expect(buildRaffleResultMessage(9, ['a', 'b', 'c'], 33))
      .toBe('🎉 Raffle over! 9 entries, 3 winners: @a, @b and @c win 33 points each!');
  });
});
