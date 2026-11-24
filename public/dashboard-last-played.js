/* global clearChildren, relativeTime */
/* ── Last-played line (dashboard Voice service) ───────────── */
// What the Voice service says about the last sound played in this guild: the command and file, where it came from,
// who triggered it and when, on one wrapping line. Playback information, not a health state. Every value is written
// with textContent, never as markup, and each name sits in its own <bdi> so a right-to-left name can't reorder the
// separators or the time. Loaded before dashboard-status.js, which calls renderLastPlayed from applyStatusCards.

/** How each trigger source is named on the last-played line. */
const LAST_PLAYED_SOURCES = { discord: 'Discord', twitch: 'Twitch', streamdeck: 'Stream Deck' };

/**
 * Reads a value that must be a non-empty string.
 * @param value - Anything.
 * @returns The value when it is a non-empty string, else null.
 */
function lastPlayedText(value) {
  return typeof value === 'string' && value !== '' ? value : null;
}

/**
 * Reads the last-played fields of a status payload's `voice` section into the parts of the line. Pure. A field that is
 * not a non-empty string (or, for the time, a valid date) counts as absent, so nothing is ever invented.
 * @param voice - The `voice` section of an /api/status payload.
 * @returns `null` when nothing has played since the bot started, else `{ command, file, source, channel, user, playedAt }`
 *   where each part is a string or null (`source` is the display name: Discord, Twitch or Stream Deck).
 */
function formatLastPlayed(voice) {
  const playedAt = lastPlayedText(voice && voice.lastPlayedAt);
  if (!playedAt || Number.isNaN(Date.parse(playedAt))) return null;
  const known = typeof voice.lastSource === 'string' && Object.hasOwn(LAST_PLAYED_SOURCES, voice.lastSource);
  const source = known ? LAST_PLAYED_SOURCES[voice.lastSource] : null;
  return {
    command: lastPlayedText(voice.lastCommand),
    file: lastPlayedText(voice.lastFile),
    source,
    channel: source === 'Twitch' ? lastPlayedText(voice.lastChannel) : null,
    user: lastPlayedText(voice.lastUser),
    playedAt,
  };
}

/**
 * Appends a name to an element inside its own `<bdi>`, so a right-to-left name can't reorder what is around it. Text only.
 * @param parent - The element the name is added to.
 * @param value - The name (a command, file, channel or user).
 * @param className - Optional class for the `<bdi>`.
 */
function appendIsolatedText(parent, value, className) {
  const bdi = document.createElement('bdi');
  if (className) bdi.className = className;
  bdi.textContent = value;
  parent.appendChild(bdi);
}

/**
 * Builds the sound's piece of the line: the command with its file in brackets ("!clap (clap.mp3)"), or whichever of the two is known.
 * @param parts - The result of formatLastPlayed.
 * @returns A span, or null when neither the command nor the file is known.
 */
function buildSoundPiece(parts) {
  if (!parts.command && !parts.file) return null;
  const sound = document.createElement('span');
  const both = Boolean(parts.command && parts.file);
  if (parts.command) appendIsolatedText(sound, parts.command, 'mono');
  if (both) sound.appendChild(document.createTextNode(' ('));
  if (parts.file) appendIsolatedText(sound, parts.file, 'mono');
  if (both) sound.appendChild(document.createTextNode(')'));
  return sound;
}

/**
 * Builds the origin's piece of the line: the source's name, with "#channel" after Twitch.
 * @param parts - The result of formatLastPlayed.
 * @returns A span, or null when the source is unknown.
 */
function buildOriginPiece(parts) {
  if (!parts.source) return null;
  const origin = document.createElement('span');
  origin.appendChild(document.createTextNode(parts.source));
  if (parts.channel) {
    origin.appendChild(document.createTextNode(' #'));
    appendIsolatedText(origin, parts.channel);
  }
  return origin;
}

/**
 * Builds the user's piece of the line.
 * @param parts - The result of formatLastPlayed.
 * @returns A span holding the user's name, or null when it is unknown.
 */
function buildUserPiece(parts) {
  if (!parts.user) return null;
  const who = document.createElement('span');
  appendIsolatedText(who, parts.user);
  return who;
}

/**
 * Builds the time's piece of the line.
 * @param parts - The result of formatLastPlayed.
 * @returns A `<time>` element with its date and how long ago it was.
 */
function buildTimePiece(parts) {
  const when = document.createElement('time');
  when.dateTime = parts.playedAt;
  when.textContent = relativeTime(parts.playedAt);
  return when;
}

/**
 * Draws the last-played line into `el`: "!clap (clap.mp3) · Twitch #streamer_one · user1 · 2m ago", leaving out any
 * part that is unknown, or "Nothing played since the bot started" when nothing has played. Does nothing when the
 * element is missing.
 * @param el - The last-played line element.
 * @param voice - The `voice` section of an /api/status payload.
 */
function renderLastPlayed(el, voice) {
  if (!el) return;
  clearChildren(el);
  const parts = formatLastPlayed(voice);
  if (!parts) {
    el.textContent = 'Nothing played since the bot started';
    return;
  }
  const pieces = [buildSoundPiece(parts), buildOriginPiece(parts), buildUserPiece(parts), buildTimePiece(parts)].filter(Boolean);
  pieces.forEach((piece, index) => {
    if (index > 0) el.appendChild(document.createTextNode(' · '));
    el.appendChild(piece);
  });
}
