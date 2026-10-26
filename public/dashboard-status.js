/* global clearChildren, relativeTime, setClass, setText */
/* ── Status rendering & polling ──────────────────────────── */

/**
 * Lists each monitored channel with its live/offline dot, or "None configured." when there are none.
 * @param container - The element the channel list is rendered into.
 * @param channelMap - Map of Twitch channel name to its live state from /api/status.
 */
function renderChannels(container, channelMap) {
  clearChildren(container);
  const entries = Object.entries(channelMap);
  if (entries.length === 0) {
    const p = document.createElement('p');
    p.className = 'empty-msg';
    p.textContent = 'None configured.';
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
 * Updates the dashboard (Discord bot, voice connection, last played sound, channels) from an /api/status response.
 * @param status - The parsed /api/status JSON (`discord`, `voice`, `twitch` sections, plus the last played sound).
 */
function applyStatus(status) {
  // Discord bot
  const discordOn = status.discord.ready;
  setClass('dot-discord', discordOn ? 'dot dot--online' : 'dot dot--offline');
  setText('discord-tag',   status.discord.tag);
  setText('discord-guild', status.discord.guildName);

  // Voice
  const voiceOn = status.voice.connected;
  setClass('dot-voice', voiceOn ? 'dot dot--online' : 'dot dot--offline');
  setText('voice-channel', status.voice.channelName);

  const voiceStateEl = document.getElementById('voice-state');
  if (voiceStateEl) {
    if (!voiceOn) {
      voiceStateEl.textContent = 'Not connected';
      voiceStateEl.style.color = 'var(--danger)';
    } else if (status.voice.playing) {
      voiceStateEl.textContent = `▶ Playing…`;
      voiceStateEl.style.color = 'var(--warning)';
      setClass('dot-voice', 'dot dot--playing');
    } else {
      voiceStateEl.textContent = 'Idle';
      voiceStateEl.style.color = 'var(--success)';
    }
  }

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
  const twitchEl = document.getElementById('twitch-channels');
  if (twitchEl) renderChannels(twitchEl, status.twitch);
}

let consecutiveFailures = 0;
const STALE_THRESHOLD = 3;

/** Polls /api/status and applies it, showing "(status unavailable)" after STALE_THRESHOLD failures in a row. */
async function fetchStatus() {
  try {
    const res = await fetch('/api/status');
    if (!res.ok) {
      consecutiveFailures++;
    } else {
      const data = await res.json();
      consecutiveFailures = 0;
      applyStatus(data);
    }
  } catch (_) {
    consecutiveFailures++;
  }
  if (consecutiveFailures >= STALE_THRESHOLD) {
    const staleEl = document.getElementById('discord-tag');
    if (staleEl) staleEl.textContent = '(status unavailable)';
  }
}
