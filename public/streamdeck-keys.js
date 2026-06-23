/** Returns the confirmation message for revoking the current user's Streamdeck API key. */
function getRevokeKeyConfirmationMessage() {
  return 'Revoke your API key? It will stop working immediately.';
}

/** Confirms revocation before allowing the Streamdeck key revoke form to submit. */
document.addEventListener('submit', function (event) {
  confirmSubmit(event, 'js-confirm-revoke-key', getRevokeKeyConfirmationMessage);
});

const copyBtn = document.getElementById('copy-key-btn');
if (copyBtn) {
  /** Copies the newly generated Streamdeck API key to the clipboard and shows brief feedback on the button. */
  copyBtn.addEventListener('click', function () {
    const keyEl = document.getElementById('new-key');
    const key = keyEl ? keyEl.textContent : '';
    if (!navigator.clipboard || typeof navigator.clipboard.writeText !== 'function') {
      alert('Could not copy automatically — please copy the key manually.');
      return;
    }
    navigator.clipboard.writeText(key).then(() => {
      copyBtn.textContent = 'Copied!';
      setTimeout(() => { copyBtn.textContent = 'Copy'; }, 2000);
    }).catch(() => { alert('Could not copy automatically — please copy the key manually.'); });
  });
}

const hostCell = document.getElementById('sd-host-cell');
if (hostCell) hostCell.textContent = window.location.hostname;
