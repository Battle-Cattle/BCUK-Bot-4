/* ── Recent events rendering & live feed ─────────────────── */

const EVENT_ICONS = {
  follow: '💜',
  sub: '🌟',
  resub: '🔁',
  giftsub: '🎁',
  raid: '🚀',
  redemption: '🪙',
};

const EVENT_LABELS = {
  follow: 'followed',
  sub: 'subscribed',
  resub: 'resubscribed',
  giftsub: 'gifted a sub',
  raid: 'raided',
  redemption: 'redeemed',
};

const MAX_DISPLAYED_EVENTS = 20;

function renderEventItem(ev) {
  const item = document.createElement('div');
  item.className = 'event-item';

  const icon = document.createElement('span');
  icon.className = 'event-icon';
  icon.textContent = EVENT_ICONS[ev.eventType] || '•';

  const body = document.createElement('div');
  body.className = 'event-body';

  const line = document.createElement('div');
  line.className = 'event-line';
  line.textContent = `${ev.displayName} ${EVENT_LABELS[ev.eventType] || ev.eventType}`;
  if (ev.detail) {
    line.textContent += ` — ${ev.detail}`;
  }

  const meta = document.createElement('div');
  meta.className = 'event-meta';
  meta.textContent = relativeTime(ev.occurredAt);

  body.appendChild(line);
  body.appendChild(meta);
  item.appendChild(icon);
  item.appendChild(body);
  return item;
}

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

function prependEvent(container, ev) {
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

/** Re-fetches and re-renders the full recent-events list, used to resync after a reconnect. */
async function resyncRecentEvents() {
  try {
    const res = await fetch('/dashboard/events/recent');
    if (!res.ok) return;
    const data = await res.json();
    if (data.ok) renderEvents(recentEventsList, data.events);
  } catch {
    // EventSource itself keeps retrying the stream; ignore fetch failures here.
  }
}

if (recentEventsList && hasStreamer) {
  const eventsSource = new EventSource('/dashboard/events');
  eventsSource.onmessage = (msg) => {
    try {
      prependEvent(recentEventsList, JSON.parse(msg.data));
    } catch {
      // Ignore malformed payloads.
    }
  };
  // The SSE handshake sends no state, only a live push on the next new event, so a dropped
  // connection (network blip, server restart) would otherwise leave this feed stale after
  // the browser's built-in auto-reconnect until the next real event happens to occur.
  eventsSource.onerror = () => { resyncRecentEvents(); };
}
