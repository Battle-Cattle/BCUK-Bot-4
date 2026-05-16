function copyKey(event) {
  const key = document.getElementById('new-key').textContent;
  navigator.clipboard.writeText(key).then(() => {
    const btn = event.currentTarget;
    btn.textContent = 'Copied!';
    setTimeout(() => { btn.textContent = 'Copy'; }, 2000);
  }).catch(() => { alert('Could not copy automatically — please copy the key manually.'); });
}

const hostCell = document.getElementById('sd-host-cell');
if (hostCell) hostCell.textContent = window.location.hostname;
