/* ── Status polling ─────────────────────────────────────── */

function relativeTime(isoString) {
  if (!isoString) return '—';
  const s = Math.floor((Date.now() - new Date(isoString).getTime()) / 1000);
  const thresholds = [
    [5,     'just now'],
    [60,    `${s}s ago`],
    [3600,  `${Math.floor(s / 60)}m ago`],
    [86400, `${Math.floor(s / 3600)}h ago`],
  ];
  const match = thresholds.find(([limit]) => s < limit);
  return match ? match[1] : `${Math.floor(s / 86400)}d ago`;
}

function setText(id, value) {
  const el = document.getElementById(id);
  if (el) el.textContent = value || '—';
}

function setClass(id, className) {
  const el = document.getElementById(id);
  if (!el) return;
  el.className = el.className.replace(/dot--\S+/g, '').trim();
  for (const cls of className.split(' ')) {
    if (cls) el.classList.add(cls);
  }
}

function clearChildren(el) {
  while (el.firstChild) el.removeChild(el.firstChild);
}

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
    const label = online ? 'Online' : 'Offline';
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

    const badge = document.createElement('span');
    badge.className = `badge ${cls}`;
    badge.textContent = label;

    item.appendChild(left);
    item.appendChild(badge);
    container.appendChild(item);
  }
}

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
  const tiktokEl = document.getElementById('tiktok-channels');
  if (tiktokEl) renderChannels(tiktokEl, status.tiktok);
}

let consecutiveFailures = 0;
const STALE_THRESHOLD = 3;

let voiceChannelPollTimer = null;

function setSelectError(select) {
  select.innerHTML = '<option value="">Failed to load channels</option>';
  select.disabled = true;
}

function restoreVoiceSelection(select, previousValue, data) {
  if (previousValue) select.value = previousValue;
  const restored = previousValue && select.value === previousValue;
  if (restored) return;
  if (data.currentChannelId) select.value = data.currentChannelId;
  else if (data.defaultChannelId) select.value = data.defaultChannelId;
}

function applyVoiceChannelData(select, data) {
  if (!data.ok || !Array.isArray(data.channels)) {
    setSelectError(select);
    return 5000;
  }
  const previousValue = select.value;
  select.innerHTML = '';

  if (data.channels.length === 0) {
    const opt = document.createElement('option');
    opt.value = '';
    opt.textContent = 'No voice channels available';
    opt.disabled = true;
    select.appendChild(opt);
    select.disabled = true;
    return 5000;
  }

  select.disabled = false;
  for (const ch of data.channels) {
    const opt = document.createElement('option');
    opt.value = ch.id;
    opt.textContent = ch.name;
    select.appendChild(opt);
  }
  restoreVoiceSelection(select, previousValue, data);
  return 30000;
}

async function loadVoiceChannels() {
  clearTimeout(voiceChannelPollTimer);
  const select = document.getElementById('voice-channel-select');
  if (!select) return;
  let nextPollMs;
  try {
    const res = await fetch('/api/voice/channels');
    if (!res.ok) {
      setSelectError(select);
      nextPollMs = 5000;
    } else {
      nextPollMs = applyVoiceChannelData(select, await res.json());
    }
  } catch (_) {
    setSelectError(select);
    nextPollMs = 5000;
  }
  voiceChannelPollTimer = setTimeout(loadVoiceChannels, nextPollMs);
}

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

// Apply server-provided initial status without inline script execution.
const initialStatusRaw = document.body?.dataset?.initialStatus;
const csrfToken = document.body?.dataset?.csrfToken || '';
if (initialStatusRaw) {
  try {
    applyStatus(JSON.parse(initialStatusRaw));
  } catch {
    // Fallback to fetchStatus below.
  }
}

// Refresh immediately then poll every 5 seconds.
fetchStatus();
loadVoiceChannels();
setInterval(fetchStatus, 5000);

/* ── Rejoin Voice button ─────────────────────────────────── */

const rejoinBtn = document.getElementById('btn-rejoin-voice');
if (rejoinBtn) {
  rejoinBtn.addEventListener('click', async () => {
    const leaving = rejoinBtn.textContent === 'Leave Voice';
    const channelSelect = document.getElementById('voice-channel-select');
    const selectedChannelId = channelSelect ? channelSelect.value : '';

    rejoinBtn.disabled = true;
    rejoinBtn.textContent = leaving ? 'Leaving…' : 'Joining…';
    try {
      const endpoint = leaving ? '/api/voice/leave' : '/api/voice/join';
      const body = { _csrf: csrfToken };
      if (!leaving && selectedChannelId) {
        body.channelId = selectedChannelId;
      }

      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (res.ok) {
        await fetchStatus();
        await loadVoiceChannels();
        rejoinBtn.textContent = leaving ? 'Join Voice' : 'Leave Voice';
      } else {
        rejoinBtn.textContent = 'Failed';
        setTimeout(() => { rejoinBtn.textContent = leaving ? 'Leave Voice' : 'Join Voice'; }, 3000);
      }
    } catch (_) {
      rejoinBtn.textContent = 'Failed';
      setTimeout(() => { rejoinBtn.textContent = leaving ? 'Leave Voice' : 'Join Voice'; }, 3000);
    } finally {
      rejoinBtn.disabled = false;
    }
  });
}
