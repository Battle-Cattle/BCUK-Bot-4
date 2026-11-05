import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mockLogger } from '../test-utils/loggerMock';
import { removeFiles, removeIfOlderThan, truncateOrLog } from './chunkedUploadFiles';

let dir: string;
const log = mockLogger() as never as Parameters<typeof removeFiles>[1];

beforeEach(async () => {
  dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'chunked-files-'));
});

afterEach(async () => {
  vi.restoreAllMocks();
  await fs.promises.rm(dir, { recursive: true, force: true });
});

describe('removeFiles', () => {
  it('removes every file, counting a missing one as gone', async () => {
    const file = path.join(dir, 'a');
    await fs.promises.writeFile(file, 'x');
    expect(await removeFiles([file, path.join(dir, 'missing')], log)).toBe(true);
    expect(fs.existsSync(file)).toBe(false);
  });

  it('reports a failed removal instead of throwing', async () => {
    vi.spyOn(fs.promises, 'rm').mockRejectedValueOnce(new Error('EBUSY'));
    expect(await removeFiles([path.join(dir, 'a')], log)).toBe(false);
  });
});

describe('removeIfOlderThan', () => {
  it('removes only a file modified before the cutoff', async () => {
    const file = path.join(dir, 'a');
    await fs.promises.writeFile(file, 'x');
    const { mtimeMs } = await fs.promises.stat(file);
    await removeIfOlderThan(file, mtimeMs - 1000, log);
    expect(fs.existsSync(file)).toBe(true);
    await removeIfOlderThan(file, mtimeMs + 1000, log);
    expect(fs.existsSync(file)).toBe(false);
  });

  it('logs instead of throwing for a file it cannot check', async () => {
    await expect(removeIfOlderThan(path.join(dir, 'missing'), Date.now(), log)).resolves.toBeUndefined();
  });
});

describe('truncateOrLog', () => {
  it('cuts a file back to the given size', async () => {
    const file = path.join(dir, 'a');
    await fs.promises.writeFile(file, 'abcdef');
    expect(await truncateOrLog(file, 2, log)).toBe(true);
    expect(await fs.promises.readFile(file, 'utf8')).toBe('ab');
  });

  it('reports a failure instead of throwing', async () => {
    expect(await truncateOrLog(path.join(dir, 'missing', 'a'), 0, log)).toBe(false);
  });
});
