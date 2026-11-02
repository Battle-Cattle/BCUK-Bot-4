import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import path from 'path';

// The project installs two TypeScript versions side by side (CLAUDE.md "TypeScript 6 + 7"):
// `typescript7` (7.x) type-checks and builds, while `typescript` (6.x) stays the package that
// typescript-eslint, sonarjs, madge and ts-node load for its JS API, which 7.x doesn't expose.
// Both ship a `tsc` bin and which one npm links depends on how it installed, so a script that
// says plain `tsc` would silently run either version. These checks keep that setup intact.

const projectRoot = path.resolve(__dirname, '..', '..');

interface PackageJson {
  version: string;
  scripts: Record<string, string>;
}

const readPackageJson = (relativePath: string): PackageJson =>
  JSON.parse(readFileSync(path.join(projectRoot, relativePath), 'utf8')) as PackageJson;

const TS7_TSC = 'node node_modules/typescript7/bin/tsc';

describe('TypeScript 6 + 7 toolchain', () => {
  it('builds and type-checks with the typescript7 compiler, called by path', () => {
    const { scripts } = readPackageJson('package.json');

    expect(scripts.build).toBe(`${TS7_TSC} -p tsconfig.build.json`);
    expect(scripts.typecheck).toBe(`${TS7_TSC} --noEmit`);
  });

  it('installs TypeScript 7 under the typescript7 alias', () => {
    expect(readPackageJson('node_modules/typescript7/package.json').version).toMatch(/^7\./);
  });

  it('keeps the root typescript package on 6.x for the tools that load its JS API', () => {
    expect(readPackageJson('node_modules/typescript/package.json').version).toMatch(/^6\./);
  });
});
