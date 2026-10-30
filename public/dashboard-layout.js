/* ── Dashboard layout: keep the sticky sidebar below the navbar ── */

/**
 * Copies the navbar's rendered height into `--dashboard-nav-offset`, which positions the sticky
 * events sidebar and sizes its feed. The navbar wraps taller on some widths, so a fixed CSS value
 * would let it cover the sidebar's top; the stylesheet's value stays as the fallback when this can't run.
 * @param navbar - The page's sticky `.navbar` element.
 */
function syncDashboardNavOffset(navbar) {
  document.documentElement.style.setProperty('--dashboard-nav-offset', `${navbar.offsetHeight}px`);
}

const dashboardNavbar = document.querySelector('.navbar');
if (dashboardNavbar && typeof ResizeObserver === 'function') {
  // Fires once on observe and again whenever the navbar wraps or unwraps.
  new ResizeObserver(() => syncDashboardNavOffset(dashboardNavbar)).observe(dashboardNavbar);
}
