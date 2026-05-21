document.querySelectorAll('.btn-toggle-eventsub').forEach(function(btn) {
  btn.addEventListener('click', function() {
    var id = btn.getAttribute('data-streamer-id');
    var row = document.getElementById('eventsub-' + id);
    if (row) row.classList.toggle('is-hidden');
  });
});
