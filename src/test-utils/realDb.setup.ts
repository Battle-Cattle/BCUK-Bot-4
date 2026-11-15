// Setup file for `npm run test:db` (vitest.db.config.mts), run before each test file. Only
// imports, in this order: realDbEnv points the app's config at this worker's scratch database
// before anything loads src/shared/config.ts, then realDbHooks registers the per-file hooks.
// (Vitest leaves setup files out of coverage, so the work lives in the imported modules.)
import './realDbEnv';
import './realDbHooks';
