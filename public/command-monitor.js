function formatWhen(value) {
  if (!value) return '—';
  try {
    return new Date(value).toLocaleTimeString();
  } catch {
    return '—';
  }
}

function renderEntries(entries) {
  var tbody = document.getElementById('command-monitor-body');
  if (!(tbody instanceof HTMLElement)) return;

  tbody.innerHTML = '';

  if (!Array.isArray(entries) || entries.length === 0) {
    var emptyRow = document.createElement('tr');
    var cell = document.createElement('td');
    cell.colSpan = 6;
    cell.className = 'empty-msg';
    cell.textContent = 'No matching custom commands or counter commands have been seen yet.';
    emptyRow.appendChild(cell);
    tbody.appendChild(emptyRow);
    return;
  }

  entries.forEach(function (entry) {
    var row = document.createElement('tr');

    var whenCell = document.createElement('td');
    whenCell.className = 'mono';
    whenCell.textContent = formatWhen(entry.createdAt);

    var sourceCell = document.createElement('td');
    var sourceBadge = document.createElement('span');
    sourceBadge.className = 'badge ' + (entry.source === 'discord' ? 'level-1' : 'badge-active');
    sourceBadge.textContent = entry.source || '—';
    sourceCell.appendChild(sourceBadge);

    var userCell = document.createElement('td');
    userCell.textContent = entry.user || '—';

    var channelCell = document.createElement('td');
    channelCell.className = 'mono';
    channelCell.textContent = entry.channel || '—';

    var commandCell = document.createElement('td');
    commandCell.className = 'mono';
    var commandText = document.createElement('strong');
    commandText.textContent = entry.command || '—';
    commandCell.appendChild(commandText);

    var responseCell = document.createElement('td');
    responseCell.className = 'command-output-cell';
    responseCell.textContent = entry.response || '—';

    row.appendChild(whenCell);
    row.appendChild(sourceCell);
    row.appendChild(userCell);
    row.appendChild(channelCell);
    row.appendChild(commandCell);
    row.appendChild(responseCell);
    tbody.appendChild(row);
  });
}

async function fetchRecentEntries() {
  try {
    var response = await fetch('/admin/command-monitor/recent', { credentials: 'same-origin' });
    if (!response.ok) return;
    var data = await response.json();
    renderEntries(data.entries || []);
  } catch {
    // Keep current content if polling fails.
  }
}

var pollHandle = null;

function startPolling() {
  if (pollHandle !== null || document.visibilityState === 'hidden') {
    return;
  }

  pollHandle = window.setInterval(fetchRecentEntries, 5000);
}

function stopPolling() {
  if (pollHandle === null) {
    return;
  }

  window.clearInterval(pollHandle);
  pollHandle = null;
}

var initialEntriesRaw = document.body && document.body.dataset ? document.body.dataset.commandMonitorEntries : '[]';
try {
  renderEntries(JSON.parse(initialEntriesRaw || '[]'));
} catch {
  renderEntries([]);
}

document.addEventListener('visibilitychange', function () {
  if (document.visibilityState === 'hidden') {
    stopPolling();
    return;
  }

  fetchRecentEntries();
  startPolling();
});

if (document.visibilityState === 'visible') {
  fetchRecentEntries();
  startPolling();
}
