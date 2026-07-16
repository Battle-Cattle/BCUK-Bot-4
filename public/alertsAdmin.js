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

/**
 * Converts a duration form's visible seconds input (0.01s increments, so streamers can reason
 * about display duration in whole/fractional seconds) into the hidden `duration_ms` field the
 * server actually stores/expects — recomputed right before submit so the two fields can never
 * drift out of sync regardless of which input events fired.
 * @param {HTMLFormElement} form - A settings form that may contain both fields.
 * @returns {void}
 */
function syncAlertDurationMs(form) {
  var secondsInput = form.querySelector('[data-duration-seconds]');
  var msInput = form.querySelector('[data-duration-ms]');
  if (!secondsInput || !msInput) return;
  var seconds = parseFloat(secondsInput.value);
  if (Number.isFinite(seconds)) msInput.value = String(Math.round(seconds * 1000));
}

document.addEventListener('submit', function (event) {
  if (event.target instanceof HTMLFormElement) syncAlertDurationMs(event.target);
});

document.addEventListener('submit', handleAlertsAdminSubmit);

registerUploadFormHandler('js-alert-upload', '/alerts/settings');
