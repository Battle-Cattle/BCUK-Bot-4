document.addEventListener('submit', function (event) {
  if (confirmSubmit(event, 'js-confirm-delete-video', function () {
    return 'Delete this video? Any reward assignments using it will be removed.';
  })) return;
  confirmSubmit(event, 'js-confirm-delete-reward', function () {
    return 'Remove this reward assignment?';
  });
});
