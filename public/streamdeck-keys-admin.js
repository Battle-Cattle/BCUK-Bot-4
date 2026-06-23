/** Returns the confirmation message for denying a pending Streamdeck key request. */
function getDenyKeyConfirmationMessage() {
  return 'Are you sure you want to deny this request?';
}

/** Returns the confirmation message for revoking an approved Streamdeck key. */
function getRevokeKeyConfirmationMessage() {
  return 'Revoke this key? It will stop working immediately.';
}

/** Confirms deny/revoke actions before allowing the admin Streamdeck key forms to submit. */
document.addEventListener('submit', function (event) {
  if (confirmSubmit(event, 'js-confirm-deny-key', getDenyKeyConfirmationMessage)) return;
  confirmSubmit(event, 'js-confirm-revoke-key-admin', getRevokeKeyConfirmationMessage);
});
