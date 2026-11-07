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
 * Returns the confirmation message for an Admin removing a video from the public library.
 * @returns {string} The text shown in the remove-from-library confirm() prompt.
 */
function getRemoveLibraryVideoConfirmationMessage() {
  return 'Remove this video from the public library? Streamers who already added it to their own videos keep their copies.';
}

/**
 * Returns the confirmation message for adding one of the streamer's videos to the public library.
 * @returns {string} The text shown in the add-to-public-library confirm() prompt.
 */
function getPublishVideoConfirmationMessage() {
  return 'Add this video to the public library? Every streamer will be able to see it and add it to their own videos, and only an Admin can remove it afterwards.';
}

/**
 * Confirms before allowing the video delete, reward-assignment delete, add-to-public-library and
 * library-removal forms to submit.
 * @param {SubmitEvent} event - The form submit event.
 * @returns {void}
 */
function handleOverlayAdminSubmit(event) {
  if (confirmSubmit(event, 'js-confirm-delete-video', getDeleteVideoConfirmationMessage)) return;
  if (confirmSubmit(event, 'js-confirm-delete-reward', getDeleteRewardConfirmationMessage)) return;
  if (confirmSubmit(event, 'js-confirm-publish-video', getPublishVideoConfirmationMessage)) return;
  confirmSubmit(event, 'js-confirm-remove-library-video', getRemoveLibraryVideoConfirmationMessage);
}

document.addEventListener('submit', handleOverlayAdminSubmit);

registerUploadFormHandler('js-overlay-upload', '/overlay/settings');
