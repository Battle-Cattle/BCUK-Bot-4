/* ── SFX public list: search + sort ─────────────────────────────────────── */

const searchInput = document.getElementById('sfx-search');
const tbody       = document.getElementById('sfx-tbody');
const noResults   = document.getElementById('no-results');
const cmdCount    = document.getElementById('cmd-count');
const headers     = document.querySelectorAll('.th-sortable');

let sortCol = null;   // 'command' | 'category' | null
let sortDir = 'asc';  // 'asc' | 'desc'
let query   = '';

function getRows() {
  return Array.from(tbody.querySelectorAll('tr'));
}

function applyFilter() {
  const rows = getRows();
  let visible = 0;

  rows.forEach((row) => {
    const cmd  = row.dataset.command || '';
    const cat  = row.dataset.category || '';
    const desc = row.dataset.description || '';
    const match = !query || cmd.includes(query) || cat.includes(query) || desc.includes(query);
    row.style.display = match ? '' : 'none';
    if (match) visible++;
  });

  if (noResults) noResults.classList.toggle('is-hidden', visible !== 0);
  if (cmdCount)  cmdCount.textContent = String(visible);
}

function applySort(col) {
  const rows = getRows();

  rows.sort((a, b) => {
    const av = (col === 'category' ? a.dataset.category : a.dataset.command) || '';
    const bv = (col === 'category' ? b.dataset.category : b.dataset.command) || '';
    const cmp = av.localeCompare(bv, undefined, { sensitivity: 'base' });
    return sortDir === 'asc' ? cmp : -cmp;
  });

  rows.forEach((row) => tbody.appendChild(row));
}

function updateSortHeaders() {
  headers.forEach((th) => {
    const col = th.dataset.col;
    const icon = th.querySelector('.sort-icon');
    if (col === sortCol) {
      th.setAttribute('aria-sort', sortDir === 'asc' ? 'ascending' : 'descending');
      if (icon) icon.textContent = sortDir === 'asc' ? '↑' : '↓';
    } else {
      th.setAttribute('aria-sort', 'none');
      if (icon) icon.textContent = '⇅';
    }
  });
}

function activateSort(th) {
  const col = th.dataset.col;
  if (sortCol === col) {
    sortDir = sortDir === 'asc' ? 'desc' : 'asc';
  } else {
    sortCol = col;
    sortDir = 'asc';
  }
  updateSortHeaders();
  applySort(sortCol);
  applyFilter();
}

headers.forEach((th) => {
  th.setAttribute('tabindex', '0');
  th.addEventListener('click', () => activateSort(th));
  th.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ' || e.key === 'Spacebar') {
      e.preventDefault();
      activateSort(th);
    }
  });
});

if (searchInput) {
  searchInput.addEventListener('input', () => {
    query = searchInput.value.toLowerCase().trim();
    applyFilter();
  });
}
