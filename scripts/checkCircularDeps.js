'use strict';

// Uses the madge Node API (rather than its CLI) because the CLI's --circular
// flag only exits non-zero on discovered cycles — it silently ignores files
// madge couldn't resolve, which would let an incomplete (and therefore
// unreliable) analysis pass CI. Failing on warnings first means an import madge
// can't follow is caught explicitly, instead of just quietly not checked.
const madge = require('madge');

madge('src', {
  fileExtensions: ['ts'],
  tsConfig: 'tsconfig.json',
}).then((result) => {
  const skipped = result.warnings().skipped;
  if (skipped.length > 0) {
    console.error('madge could not resolve the following files, so its circular-dependency check is incomplete:');
    for (const file of skipped) console.error(`  - ${file}`);
    process.exitCode = 2;
    return;
  }

  const circular = result.circular();
  if (circular.length > 0) {
    console.error(`Found ${circular.length} circular dependencies:`);
    for (const cycle of circular) console.error(`  ${cycle.join(' > ')}`);
    process.exitCode = 1;
    return;
  }

  console.log('No circular dependencies found.');
}).catch((error) => {
  console.error(error);
  process.exitCode = 2;
});
