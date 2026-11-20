/* global applyStreamOverview, clearChildren, deriveHealth, relativeTime, renderHealth, setStatusDot, setText, twitchHealth */
/* ── Status rendering & polling ──────────────────────────── */

/**
 * Picks the Twitch card's roll-up state across the guild's channels, from the same twitchHealth() the header
 * indicator uses so the two never disagree. Words and an icon (the `status-text--*` modifier), never colour alone.
 * No channels configured is neutral, not a fault; a payload that doesn't say is Unknown.
 * @param twitch - The `twitch` section of an /api/status response: channel login to `{ connected, ... }`.
 * @returns The visible state `text` (with "n of m", the connected count, when only some channels are connected) and its style `modifier`.
 */
function twitchRollupState(twitch) {
  const health = twitchHealth(twitch);
  if (health === 'neutral') return { text: 'No channels configured', modifier: 'inactive' };
  if (health === 'unknown') return { text: 'Unknown', modifier: 'unknown' };
  if (health === 'healthy') return { text: 'Connected', modifier: 'connected' };
  if (health === 'unhealthy') return { text: 'Disconnected', modifier: 'disconnected' };
  const channels = Object.values(twitch);
  const connected = channels.filter((c) => c && c.connected === true).length;
  return { text: `Degraded (${connected} of ${channels.length})`, modifier: 'degraded' };
}

/**
 * Lists each monitored channel with its connection badge, last connected/disconnected time and LIVE badge, or
 * "No Twitch channels configured." when there are none.
 * @param container - The element the channel list is rendered into.
 * @param channelMap - Map of Twitch channel name to its live state from /api/status.
 */
function renderChannels(container, channelMap) {
  clearChildren(container);
  const entries = Object.entries(channelMap);
  if (entries.length === 0) {
    const p = document.createElement('p');
    p.className = 'empty-msg';
    p.textContent = 'No Twitch channels configured.';
    container.appendChild(p);
    return;
  }

  for (const [name, info] of entries) {
    const online = info.connected;
    const ts = online ? info.lastConnectedAt : info.lastDisconnectedAt;
    const label = online ? 'Connected' : 'Disconnected';
    const cls = online ? 'badge-online' : 'badge-offline';
    const meta = ts ? relativeTime(ts) : 'Never seen';

    const item = document.createElement('div');
    item.className = 'channel-item';

    const left = document.createElement('div');
    left.className = 'channel-info';

    const channelName = document.createElement('div');
    channelName.className = 'channel-name';
    channelName.textContent = name;

    const channelMeta = document.createElement('div');
    channelMeta.className = 'channel-meta';
    channelMeta.textContent = meta;

    left.appendChild(channelName);
    left.appendChild(channelMeta);

    const right = document.createElement('div');
    right.className = 'channel-badges';

    if (online && info.isLive) {
      const liveBadge = document.createElement('span');
      liveBadge.className = 'badge badge-live';
      liveBadge.textContent = 'LIVE';
      right.appendChild(liveBadge);
    }

    const badge = document.createElement('span');
    badge.className = `badge ${cls}`;
    badge.textContent = label;
    right.appendChild(badge);

    item.appendChild(left);
    item.appendChild(right);
    container.appendChild(item);
  }
}

/**
 * Picks the Discord card's state: connected (filled dot, "Connected") or disconnected (red ring, "Disconnected").
 * Discord is a required service, so disconnected is styled as a fault.
 * @param discord - The `discord` section of an /api/status response (`ready`).
 * @returns The dot's classes, its accessible name, and the visible state text and its style modifier.
 */
function discordState(discord) {
  if (discord.ready) {
    return { dotClass: 'dot dot--online', label: 'Discord: Connected', text: 'Connected', modifier: 'connected' };
  }
  return { dotClass: 'dot dot--offline', label: 'Discord: Disconnected', text: 'Disconnected', modifier: 'disconnected' };
}

/**
 * Picks the Voice card's state: not connected, idle or playing. Voice is informational (being out of a channel is
 * normal), so not connected is neutral grey rather than a fault, and playing uses the brand accent, not amber.
 * @param voice - The `voice` section of an /api/status response (`connected`, `playing`).
 * @returns The dot's classes, its accessible name, and the visible state text and its style modifier.
 */
function voiceState(voice) {
  if (!voice.connected) {
    return { dotClass: 'dot dot--inactive', label: 'Voice: Not connected', text: 'Not connected', modifier: 'inactive' };
  }
  if (voice.playing) {
    return { dotClass: 'dot dot--playing', label: 'Voice: Playing', text: 'Playing', modifier: 'playing' };
  }
  return { dotClass: 'dot dot--online', label: 'Voice: Connected, idle', text: 'Idle', modifier: 'idle' };
}

/**
 * Shows a card's state in words, with the icon and colour its `status-text--*` modifier gives it in style.css;
 * does nothing if the element is missing.
 * @param id - Id of the state text element.
 * @param state - The state from discordState()/voiceState(): its visible `text` and style `modifier`.
 */
function setStatusText(id, state) {
  const el = document.getElementById(id);
  if (!el) return;
  el.className = `stat-value status-text status-text--${state.modifier}`;
  el.textContent = state.text;
}

/**
 * Updates the dashboard from a status payload: the cards, then the health indicator and the not-current marking.
 * The cards go first, so a malformed payload that throws part-way never clears the not-current marking; instead
 * the indicator goes to Unknown and the error propagates (the stream handler drops it, fetchStatus counts it).
 * Each successful call counts as a newer update (see statusGeneration), so an in-flight fetch can't overwrite it.
 * @param status - The parsed /api/status JSON (`discord`, `voice`, `twitch` sections, plus the last played sound).
 */
function applyStatus(status) {
  try {
    applyStatusCards(status);
  } catch (err) {
    renderHealth(deriveHealth(null, true));
    throw err;
  }
  // Only a successful apply supersedes an in-flight fetch; a malformed message must not block a pending recovery.
  statusGeneration++;
  renderHealth(deriveHealth(status, true));
  statusFeedStale = false;
  markStatusStale(false);
}

/**
 * Writes a status payload into the Discord, Voice, Last Played and Twitch cards; throws on a malformed payload.
 * @param status - The parsed /api/status JSON (`discord`, `voice`, `twitch` sections, plus the last played sound).
 */
function applyStatusCards(status) {
  // Discord bot
  const discord = discordState(status.discord);
  setStatusDot('dot-discord', discord.dotClass, discord.label);
  setStatusText('discord-state', discord);
  setText('discord-tag',   status.discord.tag);
  setText('discord-guild', status.discord.guildName);

  // Voice
  const voiceOn = status.voice.connected;
  const voice = voiceState(status.voice);
  setStatusDot('dot-voice', voice.dotClass, voice.label);
  setStatusText('voice-state', voice);
  setText('voice-channel', status.voice.channelName);

  // Keep the rejoin/leave button label in sync with connection state
  const voiceBtn = document.getElementById('btn-rejoin-voice');
  if (voiceBtn && !voiceBtn.disabled) {
    voiceBtn.textContent = voiceOn ? 'Leave Voice' : 'Join Voice';
  }

  // Last played
  setText('last-command', status.voice.lastCommand);
  setText('last-file',    status.voice.currentFile || (status.voice.lastCommand && '—'));
  setText('last-source',  status.voice.lastSource);
  setText('last-when',    relativeTime(status.voice.lastPlayedAt));

  // Channels
  setStatusText('twitch-state', twitchRollupState(status.twitch));
  const twitchEl = document.getElementById('twitch-channels');
  if (twitchEl) renderChannels(twitchEl, status.twitch);

  // Stream Overview: last, so a malformed payload that throws above never updates it. `false` and not
  // isStatusFeedStale(): applyStatus clears the stale flag only after the cards are written, so a recovering
  // payload would otherwise leave the panel stuck on Unknown.
  applyStreamOverview(status.twitch, false);
}

let consecutiveFailures = 0;
const STALE_THRESHOLD = 3;
/** Counts applied status updates, so fetchStatus can drop a response that a newer stream message overtook. */
let statusGeneration = 0;
/** Whether the /dashboard/status/events stream's last event was an open or a message (not an error). */
let statusStreamOpen = false;
/** Whether the dashboard is showing its last values as not current because the status feed is unreachable. */
let statusFeedStale = false;

/**
 * Marks the System Status panel and Stream Overview as not current (muted, "Unknown" states, a note saying so) or clears that.
 * Clearing only lifts the styling and note: the next applyStatus has already rewritten every value.
 * @param stale - True while the status feed is unreachable.
 */
function markStatusStale(stale) {
  const section = document.getElementById('bot-status');
  if (section) section.classList.toggle('is-stale', stale);
  const note = document.getElementById('status-stale-note');
  if (note) note.hidden = !stale;
  if (!stale) return;
  const unknown = { text: 'Unknown', modifier: 'unknown' };
  setStatusText('discord-state', unknown);
  setStatusText('voice-state', unknown);
  setStatusText('twitch-state', unknown);
  applyStreamOverview(null, true);
  setStatusDot('dot-discord', 'dot dot--unknown', 'Discord: Status unknown');
  setStatusDot('dot-voice', 'dot dot--unknown', 'Voice: Status unknown');
}

/**
 * Flags the feed unreachable once /api/status has failed STALE_THRESHOLD times in a row while the status stream is
 * also down: the indicator goes to Unknown and the cards stop presenting their last values as current. Only fresh
 * data (applyStatus) clears it, never the stream merely reopening, because the stream sends no snapshot on connect.
 */
function checkStatusFeed() {
  if (statusFeedStale || statusStreamOpen || consecutiveFailures < STALE_THRESHOLD) return;
  statusFeedStale = true;
  renderHealth(deriveHealth(null, false));
  markStatusStale(true);
}

/**
 * Records whether the status stream is up (app.js calls this from the EventSource's open, message and error events).
 * @param open - True on open or a message, false on an error (connecting again or closed).
 */
function setStatusStreamOpen(open) {
  statusStreamOpen = open;
  if (!open) checkStatusFeed();
}

/**
 * Whether the dashboard currently shows its values as not current.
 * @returns True while the status feed is flagged unreachable.
 */
function isStatusFeedStale() {
  return statusFeedStale;
}

/**
 * Polls /api/status and applies it, unless a newer update (a stream message) was applied while the request was in
 * flight: that response is dropped untouched, without resetting the failure count. After STALE_THRESHOLD failures
 * in a row with the stream down, flags the feed unreachable.
 */
async function fetchStatus() {
  const generation = statusGeneration;
  try {
    const res = await fetch('/api/status');
    if (!res.ok) {
      consecutiveFailures++;
    } else {
      const data = await res.json();
      if (generation !== statusGeneration) return;
      applyStatus(data);
      // Reset only once the payload applied: a 200 with a malformed body throws above and counts as a failure.
      consecutiveFailures = 0;
    }
  } catch (_) {
    consecutiveFailures++;
  }
  checkStatusFeed();
}
