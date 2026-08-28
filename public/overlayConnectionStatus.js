(function () {
  const script = document.currentScript;
  const eventsUrl = script ? script.dataset.eventsUrl : '';
  if (!eventsUrl) return;

  const dot = document.getElementById('overlay-status-dot');
  const text = document.getElementById('overlay-status-text');
  if (!dot || !text) return;

  connectSse(eventsUrl, function (data) {
    if (!data || typeof data.connected !== 'boolean') return;
    dot.className = data.connected ? 'dot dot--online' : 'dot dot--offline';
    text.textContent = data.connected ? 'Connected' : 'Not connected';
  });
})();
