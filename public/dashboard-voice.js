/* ── Voice channel dropdown & controls ───────────────────── */

let voiceChannelPollTimer = null;

/** Shows "Failed" on the join/leave button for a few seconds, then restores its prior label. */
function showVoiceButtonFailure(button, leaving) {
  button.textContent = 'Failed';
  setTimeout(() => { button.textContent = leaving ? 'Leave Voice' : 'Join Voice'; }, 3000);
}

/** Replaces the voice channel dropdown with a disabled "failed to load" option. */
function setSelectError(select) {
  select.innerHTML = '<option value="">Failed to load channels</option>';
  select.disabled = true;
}

/**
 * Re-selects the previously chosen channel if it still exists, else the bot's current channel,
 * else the guild default.
 * @param {HTMLSelectElement} select - The voice channel dropdown.
 * @param {string} previousValue - The selection before the options were rebuilt.
 * @param {{ currentChannelId?: string, defaultChannelId?: string }} data - Channel list response.
 * @returns {void}
 */
function restoreVoiceSelection(select, previousValue, data) {
  if (previousValue) select.value = previousValue;
  const restored = previousValue && select.value === previousValue;
  if (restored) return;
  if (data.currentChannelId) select.value = data.currentChannelId;
  else if (data.defaultChannelId) select.value = data.defaultChannelId;
}

/**
 * Rebuilds the voice channel dropdown from a channel list response.
 * @param {HTMLSelectElement} select - The voice channel dropdown.
 * @param {{ ok: boolean, channels?: Array<{id: string, name: string}> }} data - Response body.
 * @returns {number} Milliseconds until the next poll (sooner after an error or empty list).
 */
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

/** Fetches the voice channel list into the dropdown and schedules the next refresh. */
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

const rejoinBtn = document.getElementById('btn-rejoin-voice');
if (rejoinBtn) {
  /** Joins the selected voice channel or leaves the current one, then refreshes status. */
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
        showVoiceButtonFailure(rejoinBtn, leaving);
      }
    } catch (_) {
      showVoiceButtonFailure(rejoinBtn, leaving);
    } finally {
      rejoinBtn.disabled = false;
    }
  });
}
