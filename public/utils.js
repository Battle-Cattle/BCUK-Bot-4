function confirmSubmit(event, className, buildMessage) {
  var target = event.target;
  if (!(target instanceof HTMLFormElement)) return false;
  if (!target.classList.contains(className)) return false;
  if (!window.confirm(buildMessage(target))) event.preventDefault();
  return true;
}
