/* global confirmSubmit, registerUploadFormHandler */
/**
 * Returns the confirmation message for deleting an overlay video.
 * @returns {string} The text shown in the delete-video confirm() prompt.
 */
function getDeleteVideoConfirmationMessage() {
  return 'Delete this video? Any reward assignments using it will be removed.';
}

/**
 * Returns the confirmation message for removing a reward assignment.
 * @returns {string} The text shown in the remove-reward-assignment confirm() prompt.
 */
function getDeleteRewardConfirmationMessage() {
  return 'Remove this reward assignment?';
}

/**
 * Confirms destructive deletions before allowing the video/reward-assignment delete forms to submit.
 * @param {SubmitEvent} event - The form submit event.
 * @returns {void}
 */
function handleOverlayAdminSubmit(event) {
  if (confirmSubmit(event, 'js-confirm-delete-video', getDeleteVideoConfirmationMessage)) return;
  confirmSubmit(event, 'js-confirm-delete-reward', getDeleteRewardConfirmationMessage);
}

document.addEventListener('submit', handleOverlayAdminSubmit);

registerUploadFormHandler('js-overlay-upload', '/overlay/settings');
