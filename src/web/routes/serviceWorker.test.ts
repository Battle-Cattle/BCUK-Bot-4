import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mockLogger } from '../../test-utils/loggerMock';

vi.mock('../../shared/logger', () => ({ createLogger: mockLogger }));

import fs from 'fs';
import os from 'os';
import path from 'path';
import express from 'express';
import supertest from 'supertest';
import router, { computeStaticAssetsVersion, renderServiceWorker } from './serviceWorker';

describe('computeStaticAssetsVersion', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sw-hash-test-'));
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  /** Writes `content` to `relativePath` under `tempDir`, creating parent directories as needed. */
  function writeFile(relativePath: string, content: string): void {
    const fullPath = path.join(tempDir, relativePath);
    fs.mkdirSync(path.dirname(fullPath), { recursive: true });
    fs.writeFileSync(fullPath, content);
  }

  it('returns a 16-character hex digest', () => {
    writeFile('app.js', 'console.log(1);');
    expect(computeStaticAssetsVersion(tempDir)).toMatch(/^[0-9a-f]{16}$/);
  });

  it('returns the same hash for identical directory content across calls', () => {
    writeFile('app.js', 'console.log(1);');
    writeFile('style.css', 'body{}');
    expect(computeStaticAssetsVersion(tempDir)).toBe(computeStaticAssetsVersion(tempDir));
  });

  it('changes when a file\'s content changes', () => {
    writeFile('app.js', 'console.log(1);');
    const before = computeStaticAssetsVersion(tempDir);
    writeFile('app.js', 'console.log(2);');
    expect(computeStaticAssetsVersion(tempDir)).not.toBe(before);
  });

  it('changes when a new file is added', () => {
    writeFile('app.js', 'console.log(1);');
    const before = computeStaticAssetsVersion(tempDir);
    writeFile('new-file.js', 'console.log(3);');
    expect(computeStaticAssetsVersion(tempDir)).not.toBe(before);
  });

  it('picks up changes in nested directories (e.g. icons/)', () => {
    writeFile('app.js', 'console.log(1);');
    const before = computeStaticAssetsVersion(tempDir);
    writeFile('icons/BCUK-192.png', 'binarydata');
    expect(computeStaticAssetsVersion(tempDir)).not.toBe(before);
  });

  it('excludes downloads/ from the hash', () => {
    writeFile('app.js', 'console.log(1);');
    const before = computeStaticAssetsVersion(tempDir);
    writeFile('downloads/report.zip', 'binarydata');
    expect(computeStaticAssetsVersion(tempDir)).toBe(before);
  });

  it('excludes service-worker.js itself from the hash', () => {
    writeFile('app.js', 'console.log(1);');
    writeFile('service-worker.js', "const CACHE_VERSION = '__CACHE_VERSION__';");
    const before = computeStaticAssetsVersion(tempDir);
    writeFile('service-worker.js', "const CACHE_VERSION = '__CACHE_VERSION__'; // changed");
    expect(computeStaticAssetsVersion(tempDir)).toBe(before);
  });
});

describe('renderServiceWorker', () => {
  it('substitutes every occurrence of the placeholder', () => {
    const template = "const CACHE_VERSION = 'bcuk-panel-__CACHE_VERSION__'; // __CACHE_VERSION__ again";
    const result = renderServiceWorker(template, 'abc123');
    expect(result).toBe("const CACHE_VERSION = 'bcuk-panel-abc123'; // abc123 again");
    expect(result).not.toContain('__CACHE_VERSION__');
  });

  it('leaves the template unchanged when there is no placeholder', () => {
    const template = 'const x = 1;';
    expect(renderServiceWorker(template, 'abc123')).toBe(template);
  });
});

describe('GET /service-worker.js', () => {
  it('serves the real template with the placeholder substituted, application/javascript content-type, and no-cache', async () => {
    const app = express();
    app.use(router);

    const res = await supertest(app).get('/service-worker.js');

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('application/javascript');
    expect(res.headers['cache-control']).toBe('no-cache');
    expect(res.text).not.toContain('__CACHE_VERSION__');
    expect(res.text).toMatch(/const CACHE_VERSION = 'bcuk-panel-[0-9a-f]{16}';/);
  });

  it('serves the same version on repeated requests within the same process', async () => {
    const app = express();
    app.use(router);

    const first = await supertest(app).get('/service-worker.js');
    const second = await supertest(app).get('/service-worker.js');

    expect(first.text).toBe(second.text);
  });
});

describe('path traversal containment', () => {
  let tempDir: string;
  let outsideDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sw-security-test-'));
    outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sw-security-outside-'));
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
    fs.rmSync(outsideDir, { recursive: true, force: true });
  });

  /** Writes `content` to `relativePath` under `tempDir`, creating parent directories as needed. */
  function writeFile(relativePath: string, content: string): void {
    const fullPath = path.join(tempDir, relativePath);
    fs.mkdirSync(path.dirname(fullPath), { recursive: true });
    fs.writeFileSync(fullPath, content);
  }

  it('excludes a symlink that points outside the root directory from the hash', () => {
    const outsideFile = path.join(outsideDir, 'secret.txt');
    fs.writeFileSync(outsideFile, 'original content');
    writeFile('app.js', 'console.log(1);');
    fs.symlinkSync(outsideFile, path.join(tempDir, 'escape-link.txt'));

    const before = computeStaticAssetsVersion(tempDir);
    fs.writeFileSync(outsideFile, 'changed content');

    // If the symlink were followed and hashed, changing the target's content would change the
    // version. It doesn't, proving the escaping entry was skipped rather than traversed.
    expect(computeStaticAssetsVersion(tempDir)).toBe(before);
  });

  it('does not misflag a legitimate filename that starts with ".."', () => {
    writeFile('..config.js', 'console.log(1);');

    expect(() => computeStaticAssetsVersion(tempDir)).not.toThrow();
    expect(computeStaticAssetsVersion(tempDir)).toMatch(/^[0-9a-f]{16}$/);
  });

  it('allows normal nested directories within the root', () => {
    writeFile('app.js', 'console.log(1);');
    writeFile('nested/deep/file.js', 'console.log(2);');
    writeFile('icons/icon.png', 'data');

    expect(() => computeStaticAssetsVersion(tempDir)).not.toThrow();
    const hash = computeStaticAssetsVersion(tempDir);
    expect(hash).toMatch(/^[0-9a-f]{16}$/);
  });
});
