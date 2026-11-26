/* global formatLiveCheckAge, watchStreamContext */
/* ── Own-channel live stats (dashboard) ────────────────────── */
// Viewers, uptime, category and title for the signed-in user's own channel, from the /dashboard/stream/events stream
// (#1183). Shown only while the channel is live; offline, not monitored and no channel leave the panel as it was. A
// field Twitch gave no value for has no row, and nothing is made up to fill it. Title and category are Twitch's text, so
// they are only ever written with textContent. Uptime is worked out here from `startedAt` and ticks on a timer: nothing
// is polled. The server's own clock (`serverTime`) is used for every age and uptime: it is read once per payload and
// carried forward on the browser's monotonic clock, so a wrong or stepped wall clock on this machine (an NTP correction, a
// manual change) can't make the stats look stale or the stream look like it started in the future.

/** Stats older than this (about 3 polls) are shown as last known with their age, as the status panel does for the channel's live state. */
const STREAM_STATS_STALE_MS = 3 * 60 * 1000;
/** How often the uptime and the stale check are redrawn. */
const STREAM_STATS_TICK_MS = 1000;

/** The last stats payload from the stream, or null before the first. */
let streamStats = null;
/** The last payload's server time and the monotonic reading taken when it arrived, or null when it had no usable server time. */
let streamStatsAnchor = null;
/** True after the stream errored and until its next payload: what is shown may be out of date. */
let streamStatsDown = false;
/** The last view that was drawn, as JSON, so an unchanged view leaves the DOM alone. */
let lastStreamStatsView = '';

/**
 * A reading of the browser's monotonic clock, which a change to the wall clock doesn't move.
 * @returns Milliseconds from an arbitrary start, or the wall clock where no monotonic clock exists.
 */
function streamStatsMonotonic() {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}

/**
 * The server's time now: the last payload's server time plus the monotonic time since it arrived.
 * @returns Milliseconds since the epoch; this machine's wall clock when no payload has given a server time.
 */
function streamStatsNow() {
  return streamStatsAnchor ? streamStatsAnchor.server + (streamStatsMonotonic() - streamStatsAnchor.mono) : Date.now();
}

/**
 * The time in a stats payload field as milliseconds since the epoch.
 * @param value - An ISO time string, or anything else.
 * @returns The time, or null when it isn't a string that parses as a date.
 */
function streamStatsTime(value) {
  if (typeof value !== 'string') return null;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : ms;
}

/**
 * An uptime as H:MM:SS (hours can pass 24).
 * @param ms - Uptime in milliseconds.
 * @returns For example "1:23:45".
 */
function formatStreamUptime(ms) {
  const total = Math.floor(Math.max(0, ms) / 1000);
  const pad = (n) => String(n).padStart(2, '0');
  return `${Math.floor(total / 3600)}:${pad(Math.floor((total % 3600) / 60))}:${pad(total % 60)}`;
}

/**
 * The words under the stats when they aren't current: how old they are when stale, or that live updates paused.
 * @param stale - True when the last check is older than STREAM_STATS_STALE_MS.
 * @param ageMs - Age of the last check in milliseconds, or null when unknown.
 * @param down - True while the stream is reconnecting.
 * @returns The note, or null when the stats are current.
 */
function streamStatsNote(stale, ageMs, down) {
  if (stale) return `Last known; stats last checked ${formatLiveCheckAge(ageMs)}.`;
  return down ? 'Live updates paused; showing the last known values.' : null;
}

/**
 * Works out what the stats block shows. Pure: reads nothing but its arguments.
 * @param stats - The last payload from the stream, or null.
 * @param now - The server's time now, in milliseconds.
 * @param down - True while the stream is reconnecting.
 * @returns Null when nothing should show (no payload, not monitored, or offline); else `{ viewers, uptime, category, title,
 * note }`, each null when Twitch gave no usable value. When the values are last known (stale or the stream down) the uptime
 * stops at the last check instead of counting on.
 */
function deriveStreamStats(stats, now, down) {
  if (!stats || stats.ok !== true || stats.tracked !== true || stats.live !== true) return null;
  const checked = streamStatsTime(stats.checkedAt);
  const ageMs = checked === null ? null : Math.max(0, now - checked);
  const stale = ageMs !== null && ageMs >= STREAM_STATS_STALE_MS;
  const frozen = stale || down;
  const started = streamStatsTime(stats.startedAt);
  const end = frozen && checked !== null ? checked : now;
  return {
    viewers: Number.isSafeInteger(stats.viewerCount) && stats.viewerCount >= 0 ? stats.viewerCount.toLocaleString('en-GB') : null,
    uptime: started === null ? null : formatStreamUptime(end - started),
    category: typeof stats.category === 'string' && stats.category ? stats.category : null,
    title: typeof stats.title === 'string' && stats.title ? stats.title : null,
    note: streamStatsNote(stale, ageMs, down),
  };
}

/**
 * Shows or hides one stat row and sets its text, or its tooltip for the clamped rows.
 * @param name - The row's id suffix: viewers, uptime, category or title.
 * @param text - The value, or null to hide the row.
 */
function setStreamStatRow(name, text) {
  const row = document.getElementById(`stream-stat-${name}`);
  const value = document.getElementById(`stream-stat-${name}-value`);
  if (!row || !value) return;
  row.hidden = text === null;
  value.textContent = text === null ? '' : text;
  const dd = document.getElementById(`stream-stat-${name}-dd`);
  if (dd) {
    if (text === null) dd.removeAttribute('title');
    else dd.setAttribute('title', text);
  }
}

/**
 * Draws the stats block from a derived view: the rows that have values, and the note when the values aren't current.
 * Does nothing for any element that is missing.
 * @param view - A result of deriveStreamStats.
 */
function renderStreamStats(view) {
  const block = document.getElementById('stream-stats');
  const note = document.getElementById('stream-stats-note');
  if (block) block.hidden = view === null;
  for (const name of ['viewers', 'uptime', 'category', 'title']) setStreamStatRow(name, view === null ? null : view[name]);
  if (note) {
    note.hidden = view === null || view.note === null;
    note.textContent = note.hidden ? '' : view.note;
  }
}

/** Redraws the stats from the last payload and the server's clock, only when what would show has changed. */
function refreshStreamStats() {
  const view = deriveStreamStats(streamStats, streamStatsNow(), streamStatsDown);
  const key = JSON.stringify(view);
  if (key === lastStreamStatsView) return;
  lastStreamStatsView = key;
  renderStreamStats(view);
}

/**
 * Takes a payload from the stream: keeps it, anchors the server's time to the monotonic clock, and redraws.
 * @param stats - The parsed payload (the same shape as GET /dashboard/stream/stats).
 */
function applyStreamStats(stats) {
  streamStats = stats;
  streamStatsDown = false;
  const server = stats ? streamStatsTime(stats.serverTime) : null;
  streamStatsAnchor = server === null ? null : { server, mono: streamStatsMonotonic() };
  refreshStreamStats();
}

const streamStatsOwnChannel = document.body && document.body.dataset && document.body.dataset.ownChannel;

if (streamStatsOwnChannel && typeof EventSource !== 'undefined') {
  const statsSource = new EventSource('/dashboard/stream/events');
  watchStreamContext(statsSource);
  statsSource.onmessage = (msg) => {
    try {
      applyStreamStats(JSON.parse(msg.data));
    } catch {
      // Ignore malformed payloads.
    }
  };
  // The browser keeps retrying a dropped stream; until a payload arrives again the values are marked last known.
  statsSource.onerror = () => {
    streamStatsDown = true;
    refreshStreamStats();
  };
  setInterval(refreshStreamStats, STREAM_STATS_TICK_MS);
}
