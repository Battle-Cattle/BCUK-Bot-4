import { describe, it, expect } from 'vitest';
import { execFileSync } from 'child_process';
import path from 'path';

// tsc (used by `npm run build`) and Vitest (its own esbuild transform) never
// exercise ts-node, so a TypeScript bump can break `npm run dev` while CI
// stays green — as happened with TypeScript 7, which doesn't yet expose the
// `ts.sys`-shaped API ts-node's registration step reads. This spawns a fresh
// Node process that registers ts-node exactly as the `dev` script does and
// requires a real project module, so that breakage shows up as a failing test.
describe('ts-node dev toolchain', () => {
  it('registers and transpiles a real project module without throwing', () => {
    const projectRoot = path.resolve(__dirname, '..', '..');
    const fixture = path.join(__dirname, 'pathUtils.ts');
    const script = `
      require('ts-node').register();
      const { safeResolve } = require(${JSON.stringify(fixture)});
      const result = safeResolve('/srv/files', 'audio.mp3');
      if (result !== '/srv/files/audio.mp3') {
        console.error('unexpected result: ' + result);
        process.exit(1);
      }
    `;

    try {
      execFileSync(process.execPath, ['-e', script], { cwd: projectRoot, stdio: 'pipe' });
    } catch (err) {
      const e = err as { stderr?: Buffer; message: string };
      throw new Error(
        `ts-node failed to register/transpile a project module — this breaks \`npm run dev\`:\n${e.stderr?.toString() ?? e.message}`
      );
    }
  }, 15000);
});
