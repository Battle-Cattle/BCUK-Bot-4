/** Returns the confirmation message for removing an alert asset (image or sound). */
function getDeleteAssetConfirmationMessage() {
  return 'Remove this file?';
}

/**
 * Confirms destructive deletions before allowing the image/sound delete forms to submit.
 * @param {SubmitEvent} event - The form submit event.
 * @returns {void}
 */
function handleAlertsAdminSubmit(event) {
  confirmSubmit(event, 'js-confirm-delete-asset', getDeleteAssetConfirmationMessage);
}

document.addEventListener('submit', handleAlertsAdminSubmit);

registerUploadFormHandler('js-alert-upload', '/alerts/settings');
