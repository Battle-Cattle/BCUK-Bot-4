/* global confirmSubmit, registerUploadFormHandler */
/**
 * Returns the confirmation message for deleting a shared video.
 * @returns {string} The text shown in the delete-shared-video confirm() prompt.
 */
function getDeleteSharedVideoConfirmationMessage() {
  return 'Delete this shared video? It disappears from every overlay and the Stream Deck list.';
}

/**
 * Confirms before allowing the shared video delete form to submit.
 * @param {SubmitEvent} event - The form submit event.
 * @returns {void}
 */
function handleSharedOverlayAdminSubmit(event) {
  confirmSubmit(event, 'js-confirm-delete-shared-video', getDeleteSharedVideoConfirmationMessage);
}

document.addEventListener('submit', handleSharedOverlayAdminSubmit);

registerUploadFormHandler('js-shared-upload', '/overlay/shared/settings');
