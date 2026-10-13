const $ = id => document.getElementById(id);
const statusEl = $('status');
let gamepadIdx = null, polling = false;

function setActive(id, on) {
  const el = $(id); if (!el) return;
  el.style.filter = on ? 'brightness(3)' : '';
  el.setAttribute('fill', on ? '#00d4ff' : '#272727');
}

/** Ring fill for the left stick: bright when clicked, tinted while deflected, dark at rest. */
function lsRingFill(clicked, moved) {
  if (clicked) return '#00d4ff';
  return moved ? '#0a2a3a' : '#222';
}

function poll() {
  const gps = navigator.getGamepads();
  const gp = gps[gamepadIdx];
  if (!gp) return;

  // A button (index 0) — hand brake
  setActive('btn-a', gp.buttons[0]?.pressed);

  // Triggers
  const ltVal = gp.buttons[6]?.value ?? 0;
  const rtVal = gp.buttons[7]?.value ?? 0;
  $('lt-fill').setAttribute('width', Math.round(140 * ltVal));
  $('rt-fill').setAttribute('width', Math.round(140 * rtVal));

  // Left stick
  const lx = gp.axes[0] ?? 0, ly = gp.axes[1] ?? 0;
  const R = 26;
  const lM = Math.abs(lx) > 0.08 || Math.abs(ly) > 0.08;
  const lDotX = 85 + lx * R, lDotY = 142 + ly * R;
  const lsLine = $('ls-line'), lsDot = $('ls-dot'), lsRing = $('ls-ring');
  lsDot.setAttribute('cx', lDotX);
  lsDot.setAttribute('cy', lDotY);

  // The line tracks the dot while deflected, and collapses back to centre at rest.
  lsLine.setAttribute('x2', lM ? lDotX : 85);
  lsLine.setAttribute('y2', lM ? lDotY : 142);
  lsLine.setAttribute('opacity', lM ? '0.7' : '0');
  lsDot.setAttribute('fill', lM ? '#00d4ff' : '#3a3a3a');
  lsDot.style.filter = lM ? 'brightness(1.4)' : '';
  lsRing.setAttribute('stroke', lM ? '#00d4ff' : '#333');

  // LS click
  const lsClicked = !!gp.buttons[10]?.pressed;
  lsRing.setAttribute('fill', lsRingFill(lsClicked, lM));
  lsRing.style.filter = lsClicked ? 'brightness(2)' : '';
}

function rafLoop() {
  if (!polling) return;
  poll();
  requestAnimationFrame(rafLoop);
}

function startPolling() {
  if (polling) return;
  polling = true;
  requestAnimationFrame(rafLoop);
}

function stopPolling() {
  polling = false;
}

window.addEventListener('gamepadconnected', e => {
  gamepadIdx = e.gamepad.index;
  statusEl.textContent = ''; statusEl.className = 'connected';
  startPolling();
});

window.addEventListener('gamepaddisconnected', e => {
  if (e.gamepad.index === gamepadIdx) {
    gamepadIdx = null;
    statusEl.textContent = 'No controller connected'; statusEl.className = '';
    stopPolling();
  }
});

// Fallback poll for browsers that fire gamepadconnected late
setInterval(() => {
  if (gamepadIdx !== null) return;
  const gps = navigator.getGamepads();
  for (let i = 0; i < gps.length; i++) {
    if (gps[i]) {
      gamepadIdx = i;
      statusEl.textContent = ''; statusEl.className = 'connected';
      startPolling(); break;
    }
  }
}, 500);
