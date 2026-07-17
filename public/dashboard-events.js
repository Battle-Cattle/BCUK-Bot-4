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
    renderEvents(recentEventsList, JSON.parse(initialEventsRaw));
  } catch {
    // Leave the server-rendered placeholder in place.
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
}
