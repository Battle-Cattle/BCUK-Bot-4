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
 * Derives the state of the signed-in user's own channel from `isLive` alone. Pure: reads nothing but its arguments.
 * Unknown (no data yet, a malformed payload, the status feed unreachable, or a channel entry with no live flag) is
 * never shown as Offline.
 * @param twitch - The `twitch` section of an /api/status payload, or null before any data has arrived.
 * @param ownChannel - The signed-in user's own normalised Twitch login, or null when they have none.
 * @param feedStale - True while the status feed is flagged unreachable (the last values are not current).
 * @returns `{ state, login }`: the state is live, offline, unknown, not-monitored or no-channel.
 */
function deriveStreamOverview(twitch, ownChannel, feedStale) {
  if (!ownChannel) return { state: 'no-channel', login: null };
  if (feedStale || !isStreamMap(twitch)) return { state: 'unknown', login: ownChannel };
  // An own-property check: a valid login such as `constructor` would otherwise read Object.prototype's inherited
  // member, which is truthy and would turn Not monitored into Unknown.
  const entry = Object.prototype.hasOwnProperty.call(twitch, ownChannel) ? twitch[ownChannel] : undefined;
  if (!entry) return { state: 'not-monitored', login: ownChannel };
  if (typeof entry.isLive !== 'boolean') return { state: 'unknown', login: ownChannel };
  return { state: entry.isLive ? 'live' : 'offline', login: ownChannel };
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
    state.textContent = copy.label;
  }
  if (name) {
    name.textContent = view.login || '';
    name.hidden = !view.login;
  }
  if (note) note.textContent = copy.note;
  if (link) setStreamLink(link, view.login, copy.link);
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
