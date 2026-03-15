/* ── Status polling ─────────────────────────────────────── */

function relativeTime(isoString) {
  if (!isoString) return '—';
  const diff = Date.now() - new Date(isoString).getTime();
  const s = Math.floor(diff / 1000);
  if (s < 5)  return 'just now';
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
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
    voiceBtn.textContent = voiceOn ? 'Leave Voice' : 'Rejoin Voice';
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
if (initialStatusRaw) {
  try {
    applyStatus(JSON.parse(initialStatusRaw));
  } catch {
    // Fallback to fetchStatus below.
  }
}

// Refresh immediately then poll every 5 seconds.
fetchStatus();
setInterval(fetchStatus, 5000);

/* ── SFX table search ──────────────────────────────────── */

const searchInput = document.getElementById('sfx-search');
const sfxTable    = document.getElementById('sfx-table');
const noResults   = document.getElementById('no-results');
const cmdCount    = document.getElementById('cmd-count');

if (searchInput && sfxTable) {
  searchInput.addEventListener('input', () => {
    const q = searchInput.value.toLowerCase().trim();
    const rows = sfxTable.querySelectorAll('tr.sfx-row');
    let visible = 0;

    rows.forEach((row) => {
      const cmd = row.dataset.command || '';
      const cat = row.dataset.category || '';
      const match = !q || cmd.includes(q) || cat.includes(q);
      const filesRow = row.nextElementSibling;

      if (match) {
        row.style.display = '';
        // keep the files-row visibility as-is (user may have expanded it)
        visible++;
      } else {
        row.style.display = 'none';
        if (filesRow && filesRow.classList.contains('files-row')) {
          filesRow.style.display = 'none';
        }
      }
    });

    if (noResults) noResults.style.display = visible === 0 ? '' : 'none';
    if (cmdCount)  cmdCount.textContent = String(visible);
  });
}

/* ── Toggle file list ──────────────────────────────────── */

function toggleFiles(btn) {
  const sfxRow   = btn.closest('tr.sfx-row');
  const filesRow = sfxRow && sfxRow.nextElementSibling;
  if (!filesRow || !filesRow.classList.contains('files-row')) return;

  const shown = filesRow.style.display !== 'none';
  filesRow.style.display = shown ? 'none' : '';
  btn.textContent = shown ? '▶ Files' : '▼ Files';
}

document.addEventListener('click', (event) => {
  const target = event.target;
  if (!(target instanceof Element)) return;
  const toggleBtn = target.closest('.btn-toggle-files');
  if (toggleBtn instanceof HTMLElement) {
    toggleFiles(toggleBtn);
  }
});

/* ── Rejoin Voice button ─────────────────────────────────── */

const rejoinBtn = document.getElementById('btn-rejoin-voice');
if (rejoinBtn) {
  rejoinBtn.addEventListener('click', async () => {
    const leaving = rejoinBtn.textContent === 'Leave Voice';
    rejoinBtn.disabled = true;
    rejoinBtn.textContent = leaving ? 'Leaving…' : 'Joining…';
    try {
      const endpoint = leaving ? '/api/voice/leave' : '/api/voice/join';
      const res = await fetch(endpoint, { method: 'POST' });
      if (res.ok) {
        // Refresh status immediately so the dot and button update
        await fetchStatus();
      } else {
        rejoinBtn.textContent = 'Failed';
        setTimeout(() => { rejoinBtn.textContent = leaving ? 'Leave Voice' : 'Rejoin Voice'; }, 3000);
      }
    } catch (_) {
      rejoinBtn.textContent = 'Failed';
      setTimeout(() => { rejoinBtn.textContent = leaving ? 'Leave Voice' : 'Rejoin Voice'; }, 3000);
    } finally {
      rejoinBtn.disabled = false;
    }
  });
}
