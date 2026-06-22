document.addEventListener('submit', function (event) {
  if (confirmSubmit(event, 'js-confirm-deny-key', function () {
    return 'Are you sure you want to deny this request?';
  })) return;
  confirmSubmit(event, 'js-confirm-revoke-key-admin', function () {
    return 'Revoke this key? It will stop working immediately.';
  });
});
