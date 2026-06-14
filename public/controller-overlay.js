const $ = id => document.getElementById(id);
const statusEl = $('status');
let gamepadIdx = null, polling = false;

function setActive(id, on) {
  const el = $(id); if (!el) return;
  if (on) {
    el.style.filter = 'brightness(3)';
    el.setAttribute('fill', '#00d4ff');
  } else {
    el.style.filter = '';
    el.setAttribute('fill', id === 'ls-ring' ? '#222' : '#272727');
  }
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
  const lDotX = 85 + lx * R, lDotY = 142 + ly * R;
  $('ls-dot').setAttribute('cx', lDotX);
  $('ls-dot').setAttribute('cy', lDotY);

  const lM = Math.abs(lx) > 0.08 || Math.abs(ly) > 0.08;
  const lsLine = $('ls-line'), lsDot = $('ls-dot'), lsRing = $('ls-ring');
  if (lM) {
    lsLine.setAttribute('x2', lDotX); lsLine.setAttribute('y2', lDotY);
    lsLine.setAttribute('opacity', '0.7');
    lsDot.setAttribute('fill', '#00d4ff');
    lsDot.style.filter = 'brightness(1.4)';
    if (!gp.buttons[10]?.pressed) lsRing.setAttribute('fill', '#0a2a3a');
    lsRing.setAttribute('stroke', '#00d4ff');
  } else {
    lsLine.setAttribute('x2', 85); lsLine.setAttribute('y2', 142);
    lsLine.setAttribute('opacity', '0');
    lsDot.setAttribute('fill', '#3a3a3a');
    lsDot.style.filter = '';
    if (!gp.buttons[10]?.pressed) lsRing.setAttribute('fill', '#222');
    lsRing.setAttribute('stroke', '#333');
  }

  // LS click
  if (gp.buttons[10]?.pressed) {
    lsRing.setAttribute('fill', '#00d4ff');
    lsRing.style.filter = 'brightness(2)';
  } else {
    lsRing.style.filter = '';
  }
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
