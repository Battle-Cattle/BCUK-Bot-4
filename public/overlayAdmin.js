/** Returns the confirmation message for deleting an overlay video. */
function getDeleteVideoConfirmationMessage() {
  return 'Delete this video? Any reward assignments using it will be removed.';
}

/** Returns the confirmation message for removing a reward assignment. */
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
