(function () {
  const eventsUrl = document.currentScript?.dataset.eventsUrl;
  const dot = document.getElementById('overlay-status-dot');
  const text = document.getElementById('overlay-status-text');
  if (!eventsUrl || !dot || !text) return;

  connectSse(eventsUrl, function (data) {
    if (typeof data?.connected !== 'boolean') return;
    dot.classList.toggle('dot--online', data.connected);
    dot.classList.toggle('dot--offline', !data.connected);
    text.textContent = data.connected ? 'Connected' : 'Not connected';
  });
})();
