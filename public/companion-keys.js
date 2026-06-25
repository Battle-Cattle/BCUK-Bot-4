/** Returns the confirmation message for revoking the current user's companion app token. */
function getRevokeTokenConfirmationMessage() {
  return 'Revoke your companion app token? It will stop working immediately.';
}

/** Confirms revocation before allowing the companion token revoke form to submit. */
document.addEventListener('submit', function (event) {
  confirmSubmit(event, 'js-confirm-revoke-token', getRevokeTokenConfirmationMessage);
});

const copyTokenBtn = document.getElementById('copy-token-btn');
if (copyTokenBtn) {
  /** Copies the newly generated companion app token to the clipboard and shows brief feedback on the button. */
  copyTokenBtn.addEventListener('click', function () {
    const tokenEl = document.getElementById('new-token');
    const token = tokenEl ? tokenEl.textContent : '';
    if (!navigator.clipboard || typeof navigator.clipboard.writeText !== 'function') {
      alert('Could not copy automatically — please copy the token manually.');
      return;
    }
    navigator.clipboard.writeText(token).then(() => {
      copyTokenBtn.textContent = 'Copied!';
      setTimeout(() => { copyTokenBtn.textContent = 'Copy'; }, 2000);
    }).catch(() => { alert('Could not copy automatically — please copy the token manually.'); });
  });
}
