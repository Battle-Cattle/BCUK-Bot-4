import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import ejs from 'ejs';

const viewsDir = path.join(__dirname, '../../views');

/** Recursively lists all `.ejs` files under a directory, returning paths relative to it. */
function listEjsFiles(dir: string, baseDir = dir): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) return listEjsFiles(fullPath, baseDir);
    if (entry.name.endsWith('.ejs')) return [path.relative(baseDir, fullPath)];
    return [];
  });
}

describe('EJS templates', () => {
  const templates = listEjsFiles(viewsDir);

  it('finds at least one template to check', () => {
    expect(templates.length).toBeGreaterThan(0);
  });

  it.each(templates)('%s compiles without a syntax error', (relativePath) => {
    const fullPath = path.join(viewsDir, relativePath);
    const source = fs.readFileSync(fullPath, 'utf8');
    expect(() => ejs.compile(source, { filename: fullPath })).not.toThrow();
  });
});
