(function () {
  var toggle = document.querySelector('.navbar-toggle');
  if (!toggle) return;
  var nav = toggle.closest('.navbar');
  var collapse = document.getElementById('navbar-collapse');
  var mql = window.matchMedia('(max-width: 640px)');

  /* Unconditionally sync ARIA + open state to the current viewport. */
  function syncToViewport(mobile) {
    nav.classList.remove('nav-open');
    toggle.setAttribute('aria-expanded', 'false');
    /* On mobile the collapse starts hidden; on desktop it is always visible. */
    collapse.setAttribute('aria-hidden', mobile ? 'true' : 'false');
  }

  /* Set correct initial ARIA state on page load. */
  syncToViewport(mql.matches);

  toggle.addEventListener('click', function () {
    var open = nav.classList.toggle('nav-open');
    toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
    collapse.setAttribute('aria-hidden', open ? 'false' : 'true');
  });

  document.addEventListener('click', function (e) {
    if (nav.classList.contains('nav-open') && !nav.contains(e.target)) {
      nav.classList.remove('nav-open');
      toggle.setAttribute('aria-expanded', 'false');
      collapse.setAttribute('aria-hidden', 'true');
    }
  });

  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && nav.classList.contains('nav-open')) {
      nav.classList.remove('nav-open');
      toggle.setAttribute('aria-expanded', 'false');
      collapse.setAttribute('aria-hidden', 'true');
      toggle.focus();
    }
  });

  mql.addEventListener('change', function (e) {
    syncToViewport(e.matches);
  });
}());
