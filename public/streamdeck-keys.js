/* global confirmSubmit, registerCopyToClipboardHandler */
/** Returns the confirmation message for revoking the current user's Streamdeck API key. */
function getRevokeKeyConfirmationMessage() {
  return 'Revoke your API key? It will stop working immediately.';
}

/** Returns the confirmation message for rotating (generating a new) Streamdeck API key. */
function getRotateKeyConfirmationMessage() {
  return 'Generate a new API key? Your current key will stop working immediately, everywhere it was set up.';
}

/** Confirms revocation/rotation before allowing the Streamdeck key forms to submit. */
document.addEventListener('submit', function (event) {
  if (confirmSubmit(event, 'js-confirm-revoke-key', getRevokeKeyConfirmationMessage)) return;
  confirmSubmit(event, 'js-confirm-rotate-key', getRotateKeyConfirmationMessage);
});

registerCopyToClipboardHandler('copy-key-btn', 'new-key', 'Copy');

// The plugin talks to the same address the panel is served from.
const serverUrlCell = document.getElementById('sd-server-url-cell');
if (serverUrlCell) serverUrlCell.textContent = window.location.origin;
