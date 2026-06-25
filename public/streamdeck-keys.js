/** Returns the confirmation message for revoking the current user's Streamdeck API key. */
function getRevokeKeyConfirmationMessage() {
  return 'Revoke your API key? It will stop working immediately.';
}

/** Confirms revocation before allowing the Streamdeck key revoke form to submit. */
document.addEventListener('submit', function (event) {
  confirmSubmit(event, 'js-confirm-revoke-key', getRevokeKeyConfirmationMessage);
});

registerCopyToClipboardHandler('copy-key-btn', 'new-key', 'Copy');

const hostCell = document.getElementById('sd-host-cell');
if (hostCell) hostCell.textContent = window.location.hostname;
