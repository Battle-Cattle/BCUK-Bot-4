/** Returns the confirmation message for revoking the current user's companion app token. */
function getRevokeTokenConfirmationMessage() {
  return 'Revoke your companion app token? It will stop working immediately.';
}

/** Confirms revocation before allowing the companion token revoke form to submit. */
document.addEventListener('submit', function (event) {
  confirmSubmit(event, 'js-confirm-revoke-token', getRevokeTokenConfirmationMessage);
});

registerCopyToClipboardHandler('copy-token-btn', 'new-token', 'Copy');
