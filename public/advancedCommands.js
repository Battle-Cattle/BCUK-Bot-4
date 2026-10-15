/* global confirmSubmit, registerUploadFormHandler */
// Alert image/sound uploads go through fetch with the CSRF token in a header (see utils.js).
registerUploadFormHandler('js-advanced-command-upload', '/advanced-commands');

/** Confirms before deleting a command. */
document.addEventListener('submit', function (event) {
  confirmSubmit(event, 'js-confirm-delete-command', function (t) {
    return 'Delete ' + (t.dataset.commandName || 'this command') + '? Its usage history is kept.';
  });
});
