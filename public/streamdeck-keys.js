document.addEventListener('submit', function (event) {
  confirmSubmit(event, 'js-confirm-revoke-key', function () {
    return 'Revoke your API key? It will stop working immediately.';
  });
});

const copyBtn = document.getElementById('copy-key-btn');
if (copyBtn) {
  copyBtn.addEventListener('click', function () {
    const key = document.getElementById('new-key').textContent;
    navigator.clipboard.writeText(key).then(() => {
      copyBtn.textContent = 'Copied!';
      setTimeout(() => { copyBtn.textContent = 'Copy'; }, 2000);
    }).catch(() => { alert('Could not copy automatically — please copy the key manually.'); });
  });
}

const hostCell = document.getElementById('sd-host-cell');
if (hostCell) hostCell.textContent = window.location.hostname;
