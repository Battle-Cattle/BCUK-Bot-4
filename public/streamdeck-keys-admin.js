/* global confirmSubmit */
/**
 * Returns the confirmation message for denying a pending Streamdeck key request.
 * @returns {string} The text shown in the deny-request confirm() prompt.
 */
function getDenyKeyConfirmationMessage() {
  return 'Are you sure you want to deny this request?';
}

/**
 * Returns the confirmation message for revoking an approved Streamdeck key.
 * @returns {string} The text shown in the admin revoke-key confirm() prompt.
 */
function getRevokeKeyConfirmationMessage() {
  return 'Revoke this key? It will stop working immediately.';
}

/** Confirms deny/revoke actions before allowing the admin Streamdeck key forms to submit. */
document.addEventListener('submit', function (event) {
  if (confirmSubmit(event, 'js-confirm-deny-key', getDenyKeyConfirmationMessage)) return;
  confirmSubmit(event, 'js-confirm-revoke-key-admin', getRevokeKeyConfirmationMessage);
});
