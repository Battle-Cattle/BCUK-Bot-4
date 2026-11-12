/**
 * Builds the overlay's readiness reporter: one report in flight at a time, at most one every
 * `gapMs` (all triggers share that budget, so the server's rate limit isn't hit), changes that
 * arrive meanwhile are folded into one later report of the latest state, and a rate-limited
 * report (HTTP 429) is retried later.
 * @param {{send: function(): Promise<number|undefined>, gapMs: number, retryMs: number, now: function(): number, setTimer: function(Function, number): *}} deps - `send` posts the current state and resolves with the HTTP status (or undefined if it failed); the rest is the clock and timer.
 * @returns {{request: function(): void}} `request()` asks for a report of the current state.
 */
function createReadinessReporter(deps) {
  let inFlight = false;
  let wanted = false; // a change is waiting to be reported
  let timer = null;
  let lastSentAt = -Infinity;

  /**
   * Sends now if allowed, otherwise schedules itself for when the budget allows.
   * @returns {void}
   */
  function pump() {
    if (!wanted || inFlight || timer !== null) return;
    const wait = lastSentAt + deps.gapMs - deps.now();
    if (wait > 0) {
      timer = deps.setTimer(function () { timer = null; pump(); }, wait);
      return;
    }
    void sendNow();
  }

  /**
   * Sends the latest state, then retries after a 429 or sends whatever changed meanwhile.
   * @returns {Promise<void>} Resolves when this report finished.
   */
  async function sendNow() {
    wanted = false;
    inFlight = true;
    lastSentAt = deps.now();
    let status;
    try {
      status = await deps.send();
    } catch (_) {
      status = undefined; // best effort
    }
    inFlight = false;
    if (status === 429) {
      wanted = true;
      lastSentAt = Math.max(lastSentAt, deps.now() + deps.retryMs - deps.gapMs);
    }
    pump();
  }

  return { request: function () { wanted = true; pump(); } };
}

/**
 * The download state after a syncer event: progress sets it; idle clears it; a video stored or
 * removed clears it only if that was the video downloading (another video's removal leaves a
 * running download's progress alone).
 * @param {{url: string, percent: number}|null} downloading - The download state before the event.
 * @param {{type: string, url?: string, percent?: number}} event - The syncer event.
 * @returns {{url: string, percent: number}|null} The download state after the event.
 */
function nextDownloadState(downloading, event) {
  if (event.type === 'progress') return { url: event.url, percent: event.percent };
  if (event.type === 'idle' || (downloading && event.url === downloading.url)) return null;
  return downloading;
}
