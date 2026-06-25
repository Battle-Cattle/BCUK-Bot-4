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

/**
 * Submit the video upload form via fetch with the CSRF token in an X-CSRF-Token
 * header, so the session token is never placed in the URL (history/Referer).
 * csrfProtection validates the header before Multer parses the multipart body.
 * fetch follows the server redirect; we then navigate to the resulting page.
 * @param {SubmitEvent} event - The form submit event.
 * @returns {void}
 */
function handleOverlayUploadSubmit(event) {
  const form = event.target;
  if (!(form instanceof HTMLFormElement) || !form.classList.contains('js-overlay-upload')) return;
  event.preventDefault();

  const token = (document.body && document.body.dataset.csrfToken) || '';
  const submitBtn = form.querySelector('button[type="submit"]');
  if (submitBtn) submitBtn.disabled = true;

  fetch(form.action, {
    method: 'POST',
    headers: { 'X-CSRF-Token': token },
    body: new FormData(form),
  })
    .then(function (res) {
      // Only follow an actual server redirect (success/error → /overlay/settings?…).
      // A non-redirect response (e.g. 403 CSRF, 500) keeps res.url at the POST-only
      // upload route, so treat any non-OK response as a failure instead.
      if (res.redirected && res.url) {
        window.location.assign(res.url);
        return;
      }
      if (!res.ok) throw new Error('Upload failed');
      window.location.assign('/overlay/settings');
    })
    .catch(function () {
      window.location.assign('/overlay/settings?error=upload_failed');
    });
}

document.addEventListener('submit', handleOverlayUploadSubmit);
