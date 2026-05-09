/* ── SFX table search ──────────────────────────────────── */

const searchInput = document.getElementById('sfx-search');
const sfxTable    = document.getElementById('sfx-table');
const noResults   = document.getElementById('no-results');
const cmdCount    = document.getElementById('cmd-count');

if (searchInput && sfxTable) {
  searchInput.addEventListener('input', () => {
    const q = searchInput.value.toLowerCase().trim();
    const rows = sfxTable.querySelectorAll('tr.sfx-row');
    let visible = 0;

    rows.forEach((row) => {
      const cmd = row.dataset.command || '';
      const cat = row.dataset.category || '';
      const match = !q || cmd.includes(q) || cat.includes(q);
      const filesRow = row.nextElementSibling;

      if (match) {
        row.style.display = '';
        visible++;
      } else {
        row.style.display = 'none';
        if (filesRow && filesRow.classList.contains('files-row')) {
          filesRow.classList.add('is-hidden');
          const toggleBtn = row.querySelector('.btn-toggle-files');
          if (toggleBtn) toggleBtn.textContent = '▶ Files';
        }
      }
    });

    if (noResults) noResults.classList.toggle('is-hidden', visible !== 0);
    if (cmdCount)  cmdCount.textContent = String(visible);
  });
}

/* ── Toggle file list ──────────────────────────────────── */

function toggleFiles(btn) {
  const sfxRow   = btn.closest('tr.sfx-row');
  const filesRow = sfxRow && sfxRow.nextElementSibling;
  if (!filesRow || !filesRow.classList.contains('files-row')) return;

  const shown = !filesRow.classList.contains('is-hidden');
  filesRow.classList.toggle('is-hidden', shown);
  btn.textContent = shown ? '▶ Files' : '▼ Files';
}

document.addEventListener('click', (event) => {
  const target = event.target;
  if (!(target instanceof Element)) return;
  const toggleBtn = target.closest('.btn-toggle-files');
  if (toggleBtn instanceof HTMLElement) {
    toggleFiles(toggleBtn);
  }
});
