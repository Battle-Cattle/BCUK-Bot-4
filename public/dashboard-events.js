/* global relativeTime, clearChildren, watchStreamContext */
/* ── Recent events rendering & live feed ─────────────────── */

const EVENT_ICONS = {
  follow: '💜',
  sub: '🌟',
  resub: '🔁',
  giftsub: '🎁',
  raid: '🚀',
  redemption: '🪙',
  raffle_payout_failed: '⚠️',
};

const EVENT_LABELS = {
  follow: 'followed',
  sub: 'subscribed',
  resub: 'resubscribed',
  giftsub: 'gifted a sub',
  raid: 'raided',
  redemption: 'redeemed',
  raffle_payout_failed: 'won a raffle',
};

// Source name for each event type, read out ahead of the description so the source never depends on
// the icon's colour or shape alone.
const EVENT_SOURCES = {
  follow: 'Follow',
  sub: 'Subscription',
  resub: 'Resubscription',
  giftsub: 'Gift sub',
  raid: 'Raid',
  redemption: 'Channel point redemption',
  raffle_payout_failed: 'Raffle',
};

const MAX_DISPLAYED_EVENTS = 20;

/**
 * Builds one activity-feed row: one icon for the event type (decorative, with a visually hidden source
 * name ahead of the description), who did what (with any detail) and a `<time>` saying how long ago.
 * @param ev - One recent event: `eventType`, `displayName`, optional `detail`, ISO `occurredAt` and optional numeric `id`
 *   (kept on the row so a later push of the same event can be recognised, see `isEventShown`).
 * @returns The `.event-item` element for the feed.
 */
function renderEventItem(ev) {
  const item = document.createElement('div');
  item.className = 'event-item';
  if (Number.isInteger(ev.id)) item.dataset.eventId = String(ev.id);

  const icon = document.createElement('span');
  icon.className = 'event-icon';
  icon.setAttribute('aria-hidden', 'true');
  icon.textContent = EVENT_ICONS[ev.eventType] || '•';

  const body = document.createElement('div');
  body.className = 'event-body';

  const line = document.createElement('div');
  line.className = 'event-line';
  const source = document.createElement('span');
  source.className = 'visually-hidden';
  source.textContent = `${EVENT_SOURCES[ev.eventType] || ev.eventType}: `;
  const description = document.createElement('span');
  description.textContent = `${ev.displayName} ${EVENT_LABELS[ev.eventType] || ev.eventType}`;
  if (ev.detail) {
    description.textContent += ` — ${ev.detail}`;
  }
  line.appendChild(source);
  line.appendChild(description);

  const meta = document.createElement('div');
  meta.className = 'event-meta';
  const when = document.createElement('time');
  when.dateTime = ev.occurredAt;
  when.textContent = relativeTime(ev.occurredAt);
  meta.appendChild(when);

  body.appendChild(line);
  body.appendChild(meta);
  item.appendChild(icon);
  item.appendChild(body);
  return item;
}

/**
 * Replaces the feed's contents with `events`, or an empty-state message when there are none.
 * @param container - The activity feed element to fill.
 * @param events - Recent events to show, newest first.
 */
function renderEvents(container, events) {
  clearChildren(container);
  if (events.length === 0) {
    const p = document.createElement('p');
    p.className = 'empty-msg';
    p.textContent = 'No recent activity yet.';
    container.appendChild(p);
    return;
  }
  for (const ev of events) container.appendChild(renderEventItem(ev));
}

/**
 * Whether the feed already shows an event, matched on its server-side `id`. A payload without an integer `id` (an older
 * server, or an event that couldn't be recorded) never matches, so it is shown as before.
 * @param container - The activity feed element.
 * @param ev - An event from the live stream.
 * @returns True when a row for the same `id` is in the feed.
 */
function isEventShown(container, ev) {
  if (!Number.isInteger(ev.id)) return false;
  return Array.from(container.children).some((row) => row.dataset.eventId === String(ev.id));
}

/**
 * Adds a newly arrived event to the top of the feed, keeping at most MAX_DISPLAYED_EVENTS rows. An event the feed
 * already shows (a snapshot that included it before its live push arrived) is skipped.
 * @param container - The activity feed element.
 * @param ev - The event that just arrived over the live stream.
 */
function prependEvent(container, ev) {
  if (isEventShown(container, ev)) return;
  const emptyMsg = container.querySelector('.empty-msg');
  if (emptyMsg) emptyMsg.remove();
  container.insertBefore(renderEventItem(ev), container.firstChild);
  while (container.children.length > MAX_DISPLAYED_EVENTS) {
    container.removeChild(container.lastChild);
  }
}

const recentEventsList = document.getElementById('recent-events-list');
const initialEventsRaw = document.body?.dataset?.initialEvents;
const hasStreamer = document.body?.dataset?.hasStreamer === 'true';

if (recentEventsList && initialEventsRaw) {
  try {
    // An empty array leaves the server-rendered placeholder in place — it already picks
    // the right message ("Sign in...", "Connect your Twitch account...", or "No recent
    // activity yet.") for the viewer's actual state, which this JSON payload can't tell apart.
    const initialEvents = JSON.parse(initialEventsRaw);
    if (initialEvents.length > 0) renderEvents(recentEventsList, initialEvents);
  } catch {
    // Leave the server-rendered placeholder in place.
  }
}

/** `EventSource.readyState` once the browser has given up reconnecting (the constant, kept local to this script). */
const EVENTS_STREAM_CLOSED = 2;
/** How long one snapshot request (headers and body) may take before it is abandoned, so a stalled one can't block every later resync. */
const RESYNC_TIMEOUT_MS = 15000;
/** How many times one resync re-fetches because a live event arrived while its request was in flight. */
const RESYNC_MAX_ATTEMPTS = 3;

/** Live events prepended so far; a changed count during a fetch means that snapshot may predate an event. */
let liveEventsSeen = 0;
/** True after the stream dropped: the next `open` (the reconnect) takes a snapshot, not the error itself. */
let needsResync = false;
/** True while a resync is running, so errors never start overlapping requests. */
let resyncInFlight = false;
/** True when a resync was requested during another: exactly one more runs after it settles. */
let resyncQueued = false;

/**
 * Fetches the recent events snapshot, giving up after RESYNC_TIMEOUT_MS: the deadline aborts the request and the
 * reading of its body, so the resync is released and a queued one can run.
 * @returns The events, newest first, or null when the request failed, timed out, wasn't OK or had a malformed body.
 */
async function fetchRecentEvents() {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), RESYNC_TIMEOUT_MS);
  try {
    const res = await fetch('/dashboard/events/recent', { signal: controller.signal });
    if (!res.ok) return null;
    const data = await res.json();
    return data.ok && Array.isArray(data.events) ? data.events : null;
  } catch {
    // EventSource itself keeps retrying the stream; ignore fetch failures (and timeouts) here.
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Takes one snapshot and shows it, unless a live event arrived while it was in flight: that snapshot may have been
 * read before the event was stored, so it is dropped and fetched again (a request that starts after the push includes
 * the event). Gives up after RESYNC_MAX_ATTEMPTS and keeps the live-built feed until the next resync.
 */
async function runResync() {
  for (let attempt = 0; attempt < RESYNC_MAX_ATTEMPTS; attempt++) {
    const seenBefore = liveEventsSeen;
    const events = await fetchRecentEvents();
    if (events === null) return;
    if (liveEventsSeen === seenBefore) {
      renderEvents(recentEventsList, events);
      return;
    }
  }
}

/**
 * Re-fetches and re-renders the full recent-events list, used to resync after a reconnect. One request runs at a
 * time, so an older answer can never overwrite a newer one; a request made during a run queues one more run.
 */
async function resyncRecentEvents() {
  if (resyncInFlight) {
    resyncQueued = true;
    return;
  }
  resyncInFlight = true;
  try {
    await runResync();
  } finally {
    resyncInFlight = false;
  }
  if (resyncQueued) {
    resyncQueued = false;
    await resyncRecentEvents();
  }
}

if (recentEventsList && hasStreamer) {
  const eventsSource = new EventSource('/dashboard/events');
  watchStreamContext(eventsSource);
  eventsSource.onmessage = (msg) => {
    try {
      prependEvent(recentEventsList, JSON.parse(msg.data));
      liveEventsSeen += 1;
    } catch {
      // Ignore malformed payloads.
    }
  };
  // The SSE handshake sends no state, only a live push on the next new event, so a dropped connection (network blip,
  // server restart) would otherwise leave this feed stale until the next real event. Subscribe first, then snapshot:
  // `error` only flags the drop, and the resync runs on the reconnect's `open`, so nothing between the snapshot and
  // the reconnect is missed. A stream the browser has closed for good will not reopen, so it resyncs once at once.
  // An event already in the snapshot whose live push arrives afterwards is skipped: both carry the event's `id` (#1177).
  // A payload without one (an older server, or an event that couldn't be recorded) is shown as before.
  eventsSource.onopen = () => {
    if (!needsResync) return;
    needsResync = false;
    resyncRecentEvents();
  };
  eventsSource.onerror = () => {
    if (eventsSource.readyState === EVENTS_STREAM_CLOSED) {
      needsResync = false;
      resyncRecentEvents();
      return;
    }
    needsResync = true;
  };
}
