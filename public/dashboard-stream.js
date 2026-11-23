/* ── Stream Overview (dashboard) ───────────────────────────── */
// "Is my channel broadcasting?" about the signed-in user's own channel only: other streamers' live state is the
// Twitch Channels list's business (its LIVE badge), so nothing here repeats that list. Built from the channel's
// `isLive` flag alone, never from `connected` (the chat bot's connection, which System Status shows) or the
// connection timestamps. No viewer counts, titles or other detail: the status payload carries none, and nothing is
// made up to fill a gap.

/** A valid Twitch login: the only shape a channel link is built from, so a stray value can't make a bad URL. */
const STREAM_LOGIN_PATTERN = /^[a-z0-9_]{4,25}$/;
const STREAM_TWITCH_URL = 'https://www.twitch.tv/';

/** The words for each state of "Your channel": label, a line under it, the link text (null for none) and style tone. */
const STREAM_OWN_COPY = {
  live: { label: 'Live', note: 'Broadcasting now.', link: 'Open on Twitch', tone: 'live' },
  offline: { label: 'Offline', note: 'Not broadcasting right now.', link: 'Go to Twitch', tone: 'offline' },
  unknown: { label: 'Unknown', note: 'Live status isn’t available right now.', link: 'Go to Twitch', tone: 'unknown' },
  'not-monitored': { label: 'Not monitored', note: 'The bot isn’t monitoring your channel for this server.', link: null, tone: 'unavailable' },
  'no-channel': { label: 'No channel', note: 'No Twitch channel is linked to your account. Ask a Manager or Admin to add it.', link: null, tone: 'unavailable' },
};

/** The status monitor polls Twitch every 60 s; a channel not live-checked for this many polls' time counts as stale. */
const LIVE_CHECK_STALE_MS = 3 * 60 * 1000;

/** The last derived view that was drawn, as JSON, so an unchanged status push leaves the DOM alone. */
let lastStreamOverview = '';

/**
 * Whether a status payload's `twitch` section is a usable channel map.
 * @param twitch - The `twitch` section of an /api/status payload, or anything else.
 * @returns True for a plain object (login to channel state), false for null, arrays and primitives.
 */
function isStreamMap(twitch) {
  return twitch !== null && typeof twitch === 'object' && !Array.isArray(twitch);
}

/**
 * How long ago a channel's live state was last checked, from its `liveCheckedAt` stamp.
 * @param entry - One channel's entry from the status payload's `twitch` map.
 * @param now - The current time in milliseconds since the epoch.
 * @returns Age in milliseconds (never negative), or null when the stamp is absent, null or not a valid date.
 */
function liveCheckAgeMs(entry, now) {
  if (!entry || typeof entry.liveCheckedAt !== 'string') return null;
  const checked = Date.parse(entry.liveCheckedAt);
  return Number.isNaN(checked) ? null : Math.max(0, now - checked);
}

/**
 * Whether a channel's live state is too old to show as current: its last check was about 3 polls ago or more.
 * A missing or null `liveCheckedAt` is never stale, so behaviour is unchanged without the field.
 * @param entry - One channel's entry from the status payload's `twitch` map.
 * @param now - The current time in milliseconds since the epoch.
 * @returns True when the live state was last checked 3 minutes ago or longer.
 */
function isLiveCheckStale(entry, now) {
  const age = liveCheckAgeMs(entry, now);
  return age !== null && age >= LIVE_CHECK_STALE_MS;
}

/**
 * Words for how long ago a live check was, in whole minutes, hours or days, never in colour alone.
 * @param ageMs - Age of the last live check in milliseconds.
 * @returns For example "3 minutes ago", "2 hours ago" or "3 days ago".
 */
function formatLiveCheckAge(ageMs) {
  const minutes = Math.floor(ageMs / 60000);
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? '' : 's'} ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours} hour${hours === 1 ? '' : 's'} ago`;
  return `${Math.floor(hours / 24)} days ago`;
}

/**
 * Derives the state of the signed-in user's own channel from `isLive` alone. Pure: reads nothing but its arguments.
 * Unknown (no data yet, a malformed payload, the status feed unreachable, or a channel entry with no live flag) is
 * never shown as Offline.
 * @param twitch - The `twitch` section of an /api/status payload, or null before any data has arrived.
 * @param ownChannel - The signed-in user's own normalised Twitch login, or null when they have none.
 * @param feedStale - True while the status feed is flagged unreachable (the last values are not current).
 * @param now - The current time in milliseconds; defaults to now.
 * @returns `{ state, login, checkedAgo }`: the state is live, offline, unknown, not-monitored or no-channel;
 * `checkedAgo` is the words for the age of the last live check when it is stale (live or offline only), else null.
 */
function deriveStreamOverview(twitch, ownChannel, feedStale, now = Date.now()) {
  if (!ownChannel) return { state: 'no-channel', login: null };
  if (feedStale || !isStreamMap(twitch)) return { state: 'unknown', login: ownChannel };
  // An own-property check: a valid login such as `constructor` would otherwise read Object.prototype's inherited
  // member, which is truthy and would turn Not monitored into Unknown.
  const entry = Object.prototype.hasOwnProperty.call(twitch, ownChannel) ? twitch[ownChannel] : undefined;
  if (!entry) return { state: 'not-monitored', login: ownChannel };
  if (typeof entry.isLive !== 'boolean') return { state: 'unknown', login: ownChannel };
  const stale = isLiveCheckStale(entry, now);
  return {
    state: entry.isLive ? 'live' : 'offline',
    login: ownChannel,
    checkedAgo: stale ? formatLiveCheckAge(liveCheckAgeMs(entry, now)) : null,
  };
}

/**
 * Points a link at a channel on Twitch, or hides it when there is no valid login or no text.
 * @param link - The anchor element.
 * @param login - The channel's normalised login; only a valid Twitch login gets a link.
 * @param text - The link's text, or null to hide it.
 */
function setStreamLink(link, login, text) {
  if (login && text && STREAM_LOGIN_PATTERN.test(login)) {
    link.href = STREAM_TWITCH_URL + login;
    link.textContent = text;
    link.hidden = false;
  } else {
    link.removeAttribute('href');
    link.hidden = true;
  }
}

/**
 * Draws the panel: the state in words (its icon comes from the style modifier), the channel name, a line under it
 * and the link. Does nothing for any element that is missing.
 * @param view - A result of deriveStreamOverview: `{ state, login }`.
 */
function renderStreamOverview(view) {
  const copy = STREAM_OWN_COPY[view.state];
  const state = document.getElementById('stream-own-state');
  const name = document.getElementById('stream-own-name');
  const note = document.getElementById('stream-own-note');
  const link = document.getElementById('stream-own-link');
  if (state) {
    state.className = `stream-state stream-state--${copy.tone}`;
    state.textContent = view.checkedAgo ? `${copy.label} (last known)` : copy.label;
  }
  if (name) {
    name.textContent = view.login || '';
    name.hidden = !view.login;
  }
  if (note) {
    // A stale check keeps the last-known state but says so in words: it is not current.
    note.textContent = view.checkedAgo ? `Last known state; live status last checked ${view.checkedAgo}.` : copy.note;
  }
  if (link) setStreamLink(link, view.login, view.checkedAgo ? 'Check on Twitch' : copy.link);
}

/**
 * Updates Stream Overview from a status payload. Reads the user's own channel from `data-own-channel` on the body
 * (set by the server from their own account), and redraws only when what it would show has changed.
 * @param twitch - The `twitch` section of an /api/status payload, or null.
 * @param feedStale - True to show Unknown because the status feed is unreachable.
 */
function applyStreamOverview(twitch, feedStale) {
  const ownChannel = (document.body && document.body.dataset && document.body.dataset.ownChannel) || null;
  const view = deriveStreamOverview(twitch, ownChannel, feedStale);
  const key = JSON.stringify(view);
  if (key === lastStreamOverview) return;
  lastStreamOverview = key;
  renderStreamOverview(view);
}
