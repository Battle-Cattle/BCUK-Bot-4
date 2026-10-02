/**
 * A single pending retry with capped exponential backoff and a maximum number of consecutive
 * attempts. Owns the timer and the attempt counter so a caller only decides when to schedule,
 * cancel or reset. Used by `StreamerConnection` for transient-failure subscribe retries.
 */
export class BackoffRetry {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private attemptCount = 0;

  /**
   * @param baseMs - Delay before the first retry; doubled for each consecutive attempt.
   * @param maxMs - Upper bound on any single delay.
   * @param maxAttempts - Consecutive attempts allowed before {@link schedule} gives up.
   */
  constructor(
    private readonly baseMs: number,
    private readonly maxMs: number,
    private readonly maxAttempts: number,
  ) {}

  /** Whether a retry is currently scheduled. */
  get pending(): boolean {
    return this.timer !== null;
  }

  /** Consecutive attempts scheduled since the last {@link reset}. */
  get attempts(): number {
    return this.attemptCount;
  }

  /**
   * Replaces any pending retry with a new one that runs `run` after the next backoff delay.
   * @param run - Called once when the delay elapses (not called if cancelled first).
   * @returns The delay used, or null if {@link maxAttempts} was already reached (nothing scheduled).
   */
  schedule(run: () => void): number | null {
    this.cancel();
    if (this.attemptCount >= this.maxAttempts) return null;
    const delay = Math.min(this.maxMs, this.baseMs * Math.pow(2, this.attemptCount));
    this.attemptCount++;
    this.timer = setTimeout(() => {
      this.timer = null;
      run();
    }, delay);
    return delay;
  }

  /** Cancels the pending retry, if any, keeping the attempt count. */
  cancel(): void {
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
  }

  /** Cancels the pending retry and starts the backoff over from {@link baseMs}. */
  reset(): void {
    this.cancel();
    this.attemptCount = 0;
  }
}
