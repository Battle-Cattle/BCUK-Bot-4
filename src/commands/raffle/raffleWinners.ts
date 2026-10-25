/** Most winners a single raffle can have, however many viewers enter. */
const WINNER_CAP = 5;

/** One extra possible winner per this many entrants (1–3 entrants → 1, 4–6 → 2, …). */
const ENTRANTS_PER_WINNER = 3;

/**
 * Largest number of winners a raffle with `entrants` entries can draw: one per three entrants,
 * rounded up, capped at {@link WINNER_CAP}.
 * @param entrants - Number of viewers who entered the raffle.
 * @returns The maximum winner count, or 0 when nobody entered.
 */
export function getMaxWinners(entrants: number): number {
  if (entrants <= 0) return 0;
  return Math.min(WINNER_CAP, Math.ceil(entrants / ENTRANTS_PER_WINNER));
}

/**
 * Rolls how many winners this raffle draws: uniformly random between 1 and
 * {@link getMaxWinners} for the entrant count.
 * @param entrants - Number of viewers who entered the raffle.
 * @param random - Source of uniform numbers in [0, 1); injectable for tests.
 * @returns The winner count to draw, or 0 when nobody entered.
 */
export function rollWinnerCount(entrants: number, random: () => number = Math.random): number {
  const max = getMaxWinners(entrants);
  if (max === 0) return 0;
  return Math.min(max, 1 + Math.floor(random() * max));
}

/**
 * Picks `count` distinct winners from `entrants` with a partial Fisher–Yates shuffle, leaving the
 * input untouched.
 * @param entrants - Twitch logins of everyone who entered.
 * @param count - How many winners to pick; clamped to the number of entrants.
 * @param random - Source of uniform numbers in [0, 1); injectable for tests.
 * @returns The winners' logins, in the order they were drawn.
 */
export function pickWinners(entrants: readonly string[], count: number, random: () => number = Math.random): string[] {
  const pool = [...entrants];
  const picks = Math.min(count, pool.length);
  for (let i = 0; i < picks; i++) {
    const j = i + Math.floor(random() * (pool.length - i));
    // i and j are both < pool.length: i < picks <= pool.length, and j is i plus a value below pool.length - i.
    [pool[i], pool[j]] = [pool[j]!, pool[i]!];
  }
  return pool.slice(0, picks);
}

/**
 * Each winner's share of a prize: the prize divided evenly in whole points, rounded down. Any
 * remainder isn't given out (100 points between 3 winners is 33 each).
 * @param amount - Total points the raffle gives away.
 * @param winners - Number of winners sharing the prize.
 * @returns Points per winner, or 0 when there are no winners.
 */
export function getPrizeShare(amount: number, winners: number): number {
  return winners > 0 ? Math.floor(amount / winners) : 0;
}
