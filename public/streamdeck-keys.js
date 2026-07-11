/** Returns the confirmation message for revoking the current user's Streamdeck API key. */
function getRevokeKeyConfirmationMessage() {
  return 'Revoke your API key? It will stop working immediately.';
}

/** Returns the confirmation message for rotating (generating a new) Streamdeck API key. */
function getRotateKeyConfirmationMessage() {
  return 'Generate a new API key? Your current key will stop working immediately, everywhere it was set up.';
}

/** Confirms revocation before allowing the Streamdeck key revoke form to submit. */
document.addEventListener('submit', function (event) {
  confirmSubmit(event, 'js-confirm-revoke-key', getRevokeKeyConfirmationMessage);
});

/** Confirms rotation before allowing the Streamdeck key rotate form to submit. */
document.addEventListener('submit', function (event) {
  confirmSubmit(event, 'js-confirm-rotate-key', getRotateKeyConfirmationMessage);
});

registerCopyToClipboardHandler('copy-key-btn', 'new-key', 'Copy');

const hostCell = document.getElementById('sd-host-cell');
if (hostCell) hostCell.textContent = window.location.hostname;
