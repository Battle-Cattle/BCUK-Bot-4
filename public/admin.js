document.addEventListener('submit', function (event) {
  var target = event.target;
  if (!(target instanceof HTMLFormElement)) return;
  if (!target.classList.contains('js-confirm-remove-user')) return;

  var userName = target.dataset.userName || 'this user';
  if (!window.confirm('Remove ' + userName + '?')) {
    event.preventDefault();
  }
});
