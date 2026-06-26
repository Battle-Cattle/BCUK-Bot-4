import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../shared/logger', () => ({
  createLogger: () => ({ info: vi.fn(), error: vi.fn(), warn: vi.fn() }),
}));

vi.mock('../../db', () => ({
  findTrigger: vi.fn(),
  createSfxTrigger: vi.fn(),
  updateSfxTrigger: vi.fn(),
  deleteSfxTrigger: vi.fn(),
  addSfxFile: vi.fn(),
  updateSfxFile: vi.fn(),
  deleteSfxFile: vi.fn(),
  createCategory: vi.fn(),
  renameCategory: vi.fn(),
  deleteCategory: vi.fn(),
  isMysqlDuplicateEntryError: (err: unknown) =>
    !!err && typeof err === 'object' && (err as { code?: string }).code === 'ER_DUP_ENTRY',
}));

vi.mock('../csrf', () => ({
  csrfProtection: vi.fn((req: any, _res: any, next: any) => {
    req.csrfToken = () => 'test-csrf-token';
    next();
  }),
}));

vi.mock('../middleware', () => ({
  requireMod: vi.fn((_req: any, _res: any, next: any) => next()),
}));

vi.mock('../../shared/config', () => ({
  SFX_FOLDER: '/app/sfx',
  // 1 MB so the oversized-upload test can trigger Multer's LIMIT_FILE_SIZE with a
  // just-over-1 MB buffer. Every other upload test uses a few-byte buffer.
  SFX_MAX_FILE_MB: 1,
}));

vi.mock('fs', () => ({
  default: {
    existsSync: vi.fn(() => false),
    promises: {
      mkdir: vi.fn(),
      writeFile: vi.fn(),
      rm: vi.fn(),
    },
  },
}));

import express from 'express';
import supertest from 'supertest';
import router from './sfxMutations';
import {
  findTrigger,
  createSfxTrigger,
  updateSfxTrigger,
  deleteSfxTrigger,
  addSfxFile,
  updateSfxFile,
  deleteSfxFile,
  createCategory,
  renameCategory,
  deleteCategory,
} from '../../db';
import { requireMod } from '../middleware';
import { csrfProtection } from '../csrf';
import fs from 'fs';

// Minimal buffers with correct magic bytes for each accepted format
const MP3_ID3 = Buffer.from([0x49, 0x44, 0x33, 0x04, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]);
const OGG_BUF = Buffer.from([0x4f, 0x67, 0x67, 0x53, 0x00]);
const WAV_BUF = Buffer.from([0x52, 0x49, 0x46, 0x46, 0x24, 0x00, 0x00, 0x00, 0x57, 0x41, 0x56, 0x45]);

/**
 * Build an Express app mounting the SFX mutation router with a stubbed Mod session,
 * for driving the routes with supertest.
 * @returns The configured Express app.
 */
function buildApp() {
  const app = express();
  app.use(express.urlencoded({ extended: false }));
  app.use((req: any, _res: any, next: any) => {
    req.session = { user: { discordId: '1', accessLevel: 1 } };
    next();
  });
  app.use(router);
  return app;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(findTrigger).mockResolvedValue(null);
  vi.mocked(createSfxTrigger).mockResolvedValue(1n);
  vi.mocked(updateSfxTrigger).mockResolvedValue(true);
  vi.mocked(deleteSfxTrigger).mockResolvedValue({ files: [] });
  vi.mocked(addSfxFile).mockResolvedValue(1);
  vi.mocked(updateSfxFile).mockResolvedValue(true);
  vi.mocked(deleteSfxFile).mockResolvedValue(null);
  vi.mocked(createCategory).mockResolvedValue(1);
  vi.mocked(renameCategory).mockResolvedValue(true);
  vi.mocked(deleteCategory).mockResolvedValue(true);
  vi.mocked(requireMod).mockImplementation((_req: any, _res: any, next: any) => next());
  vi.mocked(fs.existsSync).mockReturnValue(false);
  vi.mocked(fs.promises.mkdir).mockResolvedValue(undefined as any);
  vi.mocked(fs.promises.writeFile).mockResolvedValue(undefined);
  vi.mocked(fs.promises.rm).mockResolvedValue(undefined);
});

// ── Triggers ────────────────────────────────────────────────────────────────

describe('POST /sfx/trigger/add', () => {
  it('rejects a missing command', async () => {
    const res = await supertest(buildApp()).post('/sfx/trigger/add').send('trigger_command=');
    expect(res.headers.location).toBe('/sfx?error=missing_fields');
    expect(vi.mocked(createSfxTrigger)).not.toHaveBeenCalled();
  });

  it('rejects a multi-word command', async () => {
    const res = await supertest(buildApp()).post('/sfx/trigger/add').send('trigger_command=!two words');
    expect(res.headers.location).toBe('/sfx?error=missing_fields');
  });

  it('rejects a command already taken', async () => {
    vi.mocked(findTrigger).mockResolvedValue({ id: 5n } as any);
    const res = await supertest(buildApp()).post('/sfx/trigger/add').send('trigger_command=!clap');
    expect(res.headers.location).toBe('/sfx?error=command_taken');
    expect(vi.mocked(createSfxTrigger)).not.toHaveBeenCalled();
  });

  it('creates a trigger with category, description and hidden flag', async () => {
    const res = await supertest(buildApp())
      .post('/sfx/trigger/add')
      .send('trigger_command=!clap&category_id=3&description=Clap&hidden=on');
    expect(res.headers.location).toBe('/sfx?success=trigger_added');
    expect(vi.mocked(createSfxTrigger)).toHaveBeenCalledWith('!clap', 3, 'Clap', true);
  });

  it('treats category "none" as null and absent hidden as false', async () => {
    await supertest(buildApp()).post('/sfx/trigger/add').send('trigger_command=!bang&category_id=none');
    expect(vi.mocked(createSfxTrigger)).toHaveBeenCalledWith('!bang', null, null, false);
  });

  it('rejects a malformed category_id instead of clearing the category', async () => {
    const res = await supertest(buildApp())
      .post('/sfx/trigger/add')
      .send('trigger_command=!clap&category_id=abc');
    expect(res.headers.location).toBe('/sfx?error=invalid_id');
    expect(vi.mocked(createSfxTrigger)).not.toHaveBeenCalled();
  });

  it('rejects a non-string (repeated) category_id rather than treating it as unset', async () => {
    const res = await supertest(buildApp())
      .post('/sfx/trigger/add')
      .send('trigger_command=!clap&category_id=1&category_id=2');
    expect(res.headers.location).toBe('/sfx?error=invalid_id');
    expect(vi.mocked(createSfxTrigger)).not.toHaveBeenCalled();
  });

  it('maps a duplicate-entry DB error to command_taken', async () => {
    vi.mocked(createSfxTrigger).mockRejectedValue(Object.assign(new Error('dup'), { code: 'ER_DUP_ENTRY' }));
    const res = await supertest(buildApp()).post('/sfx/trigger/add').send('trigger_command=!clap');
    expect(res.headers.location).toBe('/sfx?error=command_taken');
  });

  it('redirects with add_failed on an unexpected DB error', async () => {
    vi.mocked(createSfxTrigger).mockRejectedValue(new Error('boom'));
    const res = await supertest(buildApp()).post('/sfx/trigger/add').send('trigger_command=!clap');
    expect(res.headers.location).toBe('/sfx?error=add_failed');
  });
});

describe('POST /sfx/trigger/update', () => {
  it('rejects an invalid id', async () => {
    const res = await supertest(buildApp())
      .post('/sfx/trigger/update')
      .send('trigger_id=abc&trigger_command=!clap');
    expect(res.headers.location).toBe('/sfx?error=invalid_id');
  });

  it('rejects when the command belongs to a different trigger', async () => {
    vi.mocked(findTrigger).mockResolvedValue({ id: 99n } as any);
    const res = await supertest(buildApp())
      .post('/sfx/trigger/update')
      .send('trigger_id=5&trigger_command=!clap');
    expect(res.headers.location).toBe('/sfx?error=command_taken');
    expect(vi.mocked(updateSfxTrigger)).not.toHaveBeenCalled();
  });

  it('allows keeping the same command on the same trigger', async () => {
    vi.mocked(findTrigger).mockResolvedValue({ id: 5n } as any);
    const res = await supertest(buildApp())
      .post('/sfx/trigger/update')
      .send('trigger_id=5&trigger_command=!clap&category_id=2');
    expect(res.headers.location).toBe('/sfx?success=trigger_updated');
    expect(vi.mocked(updateSfxTrigger)).toHaveBeenCalledWith(5n, '!clap', 2, null, false);
  });

  it('rejects a malformed category_id instead of clearing the category', async () => {
    const res = await supertest(buildApp())
      .post('/sfx/trigger/update')
      .send('trigger_id=5&trigger_command=!clap&category_id=abc');
    expect(res.headers.location).toBe('/sfx?error=invalid_id');
    expect(vi.mocked(updateSfxTrigger)).not.toHaveBeenCalled();
  });

  it('redirects with invalid_id when no trigger row was updated (stale id)', async () => {
    vi.mocked(updateSfxTrigger).mockResolvedValue(false);
    const res = await supertest(buildApp())
      .post('/sfx/trigger/update')
      .send('trigger_id=5&trigger_command=!clap');
    expect(res.headers.location).toBe('/sfx?error=invalid_id');
  });

  it('redirects with update_failed on an unexpected DB error', async () => {
    vi.mocked(updateSfxTrigger).mockRejectedValue(new Error('boom'));
    const res = await supertest(buildApp())
      .post('/sfx/trigger/update')
      .send('trigger_id=5&trigger_command=!clap');
    expect(res.headers.location).toBe('/sfx?error=update_failed');
  });
});

describe('POST /sfx/trigger/remove', () => {
  it('rejects an invalid id', async () => {
    const res = await supertest(buildApp()).post('/sfx/trigger/remove').send('trigger_id=0');
    expect(res.headers.location).toBe('/sfx?error=invalid_id');
  });

  it('removes the trigger and deletes its files from disk', async () => {
    vi.mocked(deleteSfxTrigger).mockResolvedValue({ files: ['a.mp3', 'b.mp3'] });
    const res = await supertest(buildApp()).post('/sfx/trigger/remove').send('trigger_id=7');
    expect(res.headers.location).toBe('/sfx?success=trigger_removed');
    expect(vi.mocked(deleteSfxTrigger)).toHaveBeenCalledWith(7n);
    expect(vi.mocked(fs.promises.rm)).toHaveBeenCalledTimes(2);
  });

  it('still redirects success when a file fails to delete from disk', async () => {
    vi.mocked(deleteSfxTrigger).mockResolvedValue({ files: ['a.mp3'] });
    vi.mocked(fs.promises.rm).mockRejectedValue(new Error('EACCES'));
    const res = await supertest(buildApp()).post('/sfx/trigger/remove').send('trigger_id=7');
    expect(res.headers.location).toBe('/sfx?success=trigger_removed');
  });

  it('redirects with invalid_id when the trigger row did not exist', async () => {
    vi.mocked(deleteSfxTrigger).mockResolvedValue(null);
    const res = await supertest(buildApp()).post('/sfx/trigger/remove').send('trigger_id=7');
    expect(res.headers.location).toBe('/sfx?error=invalid_id');
    expect(vi.mocked(fs.promises.rm)).not.toHaveBeenCalled();
  });

  it('redirects with remove_failed on an unexpected DB error', async () => {
    vi.mocked(deleteSfxTrigger).mockRejectedValue(new Error('boom'));
    const res = await supertest(buildApp()).post('/sfx/trigger/remove').send('trigger_id=7');
    expect(res.headers.location).toBe('/sfx?error=remove_failed');
  });
});

// ── Sound files ──────────────────────────────────────────────────────────────

describe('POST /sfx/file/upload', () => {
  it('rejects when trigger_id is invalid', async () => {
    const res = await supertest(buildApp())
      .post('/sfx/file/upload')
      .field('trigger_id', 'x')
      .attach('sound', MP3_ID3, { filename: 'clap.mp3', contentType: 'audio/mpeg' });
    expect(res.headers.location).toBe('/sfx?error=invalid_id');
  });

  it('rejects when no file is uploaded', async () => {
    const res = await supertest(buildApp()).post('/sfx/file/upload').field('trigger_id', '5');
    expect(res.headers.location).toBe('/sfx?error=invalid_file');
  });

  it('rejects a file with no recognised magic bytes', async () => {
    const res = await supertest(buildApp())
      .post('/sfx/file/upload')
      .field('trigger_id', '5')
      .field('weight', '1')
      .attach('sound', Buffer.from('not audio'), { filename: 'evil.mp3', contentType: 'audio/mpeg' });
    expect(res.headers.location).toBe('/sfx?error=invalid_file');
    expect(vi.mocked(fs.promises.writeFile)).not.toHaveBeenCalled();
  });

  it('uploads a valid mp3, preserving the filename', async () => {
    const res = await supertest(buildApp())
      .post('/sfx/file/upload')
      .field('trigger_id', '5')
      .field('weight', '3')
      .attach('sound', MP3_ID3, { filename: 'airhorn.mp3', contentType: 'audio/mpeg' });
    expect(res.headers.location).toBe('/sfx?success=file_uploaded');
    const writtenPath = vi.mocked(fs.promises.writeFile).mock.calls[0][0] as string;
    expect(writtenPath).toContain('airhorn.mp3');
    expect(vi.mocked(addSfxFile)).toHaveBeenCalledWith(5n, 'airhorn.mp3', 3, false);
  });

  it('accepts valid audio sent with a generic application/octet-stream content type', async () => {
    // Browsers sometimes send octet-stream for audio; the magic bytes are authoritative.
    const res = await supertest(buildApp())
      .post('/sfx/file/upload')
      .field('trigger_id', '5')
      .field('weight', '1')
      .attach('sound', OGG_BUF, { filename: 'clap.ogg', contentType: 'application/octet-stream' });
    expect(res.headers.location).toBe('/sfx?success=file_uploaded');
    expect(vi.mocked(addSfxFile)).toHaveBeenCalledWith(5n, 'clap.ogg', 1, false);
  });

  it('appends a suffix when the first exclusive write hits an existing file', async () => {
    // 'wx' write of clap.wav fails EEXIST; the retry for clap-1.wav succeeds.
    vi.mocked(fs.promises.writeFile).mockRejectedValueOnce(
      Object.assign(new Error('exists'), { code: 'EEXIST' }),
    );
    await supertest(buildApp())
      .post('/sfx/file/upload')
      .field('trigger_id', '5')
      .field('weight', '1')
      .attach('sound', WAV_BUF, { filename: 'clap.wav', contentType: 'audio/wav' });
    expect(vi.mocked(addSfxFile)).toHaveBeenCalledWith(5n, 'clap-1.wav', 1, false);
  });

  it('removes the written file when the DB insert fails', async () => {
    vi.mocked(addSfxFile).mockRejectedValue(new Error('DB error'));
    const res = await supertest(buildApp())
      .post('/sfx/file/upload')
      .field('trigger_id', '5')
      .field('weight', '1')
      .attach('sound', OGG_BUF, { filename: 'clap.ogg', contentType: 'audio/ogg' });
    expect(res.headers.location).toBe('/sfx?error=upload_failed');
    const writtenPath = vi.mocked(fs.promises.writeFile).mock.calls[0][0] as string;
    expect(vi.mocked(fs.promises.rm)).toHaveBeenCalledWith(writtenPath, { force: true });
  });

  it('redirects with invalid_path when every candidate filename collides', async () => {
    vi.mocked(fs.promises.writeFile).mockRejectedValue(
      Object.assign(new Error('exists'), { code: 'EEXIST' }),
    );
    const res = await supertest(buildApp())
      .post('/sfx/file/upload')
      .field('trigger_id', '5')
      .field('weight', '1')
      .attach('sound', MP3_ID3, { filename: 'clap.mp3', contentType: 'audio/mpeg' });
    expect(res.headers.location).toBe('/sfx?error=invalid_path');
    expect(vi.mocked(addSfxFile)).not.toHaveBeenCalled();
  });

  it('redirects with upload_failed when the write fails for a reason other than a name collision', async () => {
    vi.mocked(fs.promises.writeFile).mockRejectedValue(
      Object.assign(new Error('disk full'), { code: 'ENOSPC' }),
    );
    const res = await supertest(buildApp())
      .post('/sfx/file/upload')
      .field('trigger_id', '5')
      .field('weight', '1')
      .attach('sound', MP3_ID3, { filename: 'clap.mp3', contentType: 'audio/mpeg' });
    expect(res.headers.location).toBe('/sfx?error=upload_failed');
    expect(vi.mocked(addSfxFile)).not.toHaveBeenCalled();
  });

  it('still redirects with upload_failed when the rollback cleanup itself throws', async () => {
    vi.mocked(addSfxFile).mockRejectedValue(new Error('DB error'));
    vi.mocked(fs.promises.rm).mockRejectedValue(new Error('rm failed'));
    const res = await supertest(buildApp())
      .post('/sfx/file/upload')
      .field('trigger_id', '5')
      .field('weight', '1')
      .attach('sound', OGG_BUF, { filename: 'clap.ogg', contentType: 'audio/ogg' });
    expect(res.headers.location).toBe('/sfx?error=upload_failed');
    expect(vi.mocked(fs.promises.rm)).toHaveBeenCalled();
  });

  // End-to-end: locks the uploadSound → handleUploadError wiring so the route still
  // redirects (rather than 500s) if the middleware chain or ordering ever changes.
  it('redirects an oversized upload to file_too_large via the route middleware', async () => {
    const oversized = Buffer.alloc(1024 * 1024 + 1024, 1); // > 1 MB limit set in the config mock
    const res = await supertest(buildApp())
      .post('/sfx/file/upload')
      .field('trigger_id', '5')
      .attach('sound', oversized, { filename: 'big.mp3', contentType: 'audio/mpeg' });
    expect(res.headers.location).toBe('/sfx?error=file_too_large');
    expect(vi.mocked(fs.promises.writeFile)).not.toHaveBeenCalled();
    expect(vi.mocked(addSfxFile)).not.toHaveBeenCalled();
  });

  it('rejects a non-positive weight before writing the file', async () => {
    const res = await supertest(buildApp())
      .post('/sfx/file/upload')
      .field('trigger_id', '5')
      .field('weight', '0')
      .attach('sound', MP3_ID3, { filename: 'clap.mp3', contentType: 'audio/mpeg' });
    expect(res.headers.location).toBe('/sfx?error=invalid_weight');
    expect(vi.mocked(fs.promises.writeFile)).not.toHaveBeenCalled();
    expect(vi.mocked(addSfxFile)).not.toHaveBeenCalled();
  });
});

describe('POST /sfx/file/update', () => {
  it('rejects an invalid id', async () => {
    const res = await supertest(buildApp()).post('/sfx/file/update').send('file_id=0&weight=2');
    expect(res.headers.location).toBe('/sfx?error=invalid_id');
  });

  it('updates weight and hidden', async () => {
    const res = await supertest(buildApp())
      .post('/sfx/file/update')
      .send('file_id=11&weight=4&file_hidden=on');
    expect(res.headers.location).toBe('/sfx?success=file_updated');
    expect(vi.mocked(updateSfxFile)).toHaveBeenCalledWith(11, 4, true);
  });

  it('rejects a non-positive weight instead of overwriting with 1', async () => {
    const res = await supertest(buildApp())
      .post('/sfx/file/update')
      .send('file_id=11&weight=0&file_hidden=on');
    expect(res.headers.location).toBe('/sfx?error=invalid_weight');
    expect(vi.mocked(updateSfxFile)).not.toHaveBeenCalled();
  });

  it('rejects a partially-numeric weight rather than truncating it', async () => {
    const res = await supertest(buildApp())
      .post('/sfx/file/update')
      .send('file_id=11&weight=1.5');
    expect(res.headers.location).toBe('/sfx?error=invalid_weight');
    expect(vi.mocked(updateSfxFile)).not.toHaveBeenCalled();
  });

  it('redirects with invalid_id when no file row was updated (stale id)', async () => {
    vi.mocked(updateSfxFile).mockResolvedValue(false);
    const res = await supertest(buildApp()).post('/sfx/file/update').send('file_id=11&weight=2');
    expect(res.headers.location).toBe('/sfx?error=invalid_id');
  });

  it('redirects with update_failed on an unexpected DB error', async () => {
    vi.mocked(updateSfxFile).mockRejectedValue(new Error('boom'));
    const res = await supertest(buildApp()).post('/sfx/file/update').send('file_id=11&weight=2');
    expect(res.headers.location).toBe('/sfx?error=update_failed');
  });
});

describe('POST /sfx/file/remove', () => {
  it('rejects an invalid id', async () => {
    const res = await supertest(buildApp()).post('/sfx/file/remove').send('file_id=x');
    expect(res.headers.location).toBe('/sfx?error=invalid_id');
  });

  it('deletes the row and removes the file from disk', async () => {
    vi.mocked(deleteSfxFile).mockResolvedValue('clap.mp3');
    const res = await supertest(buildApp()).post('/sfx/file/remove').send('file_id=11');
    expect(res.headers.location).toBe('/sfx?success=file_removed');
    expect(vi.mocked(fs.promises.rm)).toHaveBeenCalled();
  });

  it('redirects with invalid_id and skips disk removal when the row did not exist', async () => {
    vi.mocked(deleteSfxFile).mockResolvedValue(null);
    const res = await supertest(buildApp()).post('/sfx/file/remove').send('file_id=11');
    expect(res.headers.location).toBe('/sfx?error=invalid_id');
    expect(vi.mocked(fs.promises.rm)).not.toHaveBeenCalled();
  });

  it('redirects with remove_failed on an unexpected DB error', async () => {
    vi.mocked(deleteSfxFile).mockRejectedValue(new Error('boom'));
    const res = await supertest(buildApp()).post('/sfx/file/remove').send('file_id=11');
    expect(res.headers.location).toBe('/sfx?error=remove_failed');
  });
});

// ── Categories ───────────────────────────────────────────────────────────────

describe('category routes', () => {
  it('rejects an empty category name', async () => {
    const res = await supertest(buildApp()).post('/sfx/category/add').send('name=');
    expect(res.headers.location).toBe('/sfx?error=missing_fields');
  });

  it('adds a category', async () => {
    const res = await supertest(buildApp()).post('/sfx/category/add').send('name=Reactions');
    expect(res.headers.location).toBe('/sfx?success=category_added');
    expect(vi.mocked(createCategory)).toHaveBeenCalledWith('Reactions');
  });

  it('renames a category', async () => {
    const res = await supertest(buildApp())
      .post('/sfx/category/rename')
      .send('category_id=3&name=Alerts');
    expect(res.headers.location).toBe('/sfx?success=category_updated');
    expect(vi.mocked(renameCategory)).toHaveBeenCalledWith(3, 'Alerts');
  });

  it('removes a category', async () => {
    const res = await supertest(buildApp()).post('/sfx/category/remove').send('category_id=3');
    expect(res.headers.location).toBe('/sfx?success=category_removed');
    expect(vi.mocked(deleteCategory)).toHaveBeenCalledWith(3);
  });

  it('redirects with add_failed when createCategory throws', async () => {
    vi.mocked(createCategory).mockRejectedValue(new Error('boom'));
    const res = await supertest(buildApp()).post('/sfx/category/add').send('name=Reactions');
    expect(res.headers.location).toBe('/sfx?error=add_failed');
  });

  it('redirects rename with invalid_id when no category row matched (stale id)', async () => {
    vi.mocked(renameCategory).mockResolvedValue(false);
    const res = await supertest(buildApp()).post('/sfx/category/rename').send('category_id=3&name=Alerts');
    expect(res.headers.location).toBe('/sfx?error=invalid_id');
  });

  it('redirects remove with invalid_id when no category row matched (stale id)', async () => {
    vi.mocked(deleteCategory).mockResolvedValue(false);
    const res = await supertest(buildApp()).post('/sfx/category/remove').send('category_id=3');
    expect(res.headers.location).toBe('/sfx?error=invalid_id');
  });

  it('redirects with update_failed when renameCategory throws', async () => {
    vi.mocked(renameCategory).mockRejectedValue(new Error('boom'));
    const res = await supertest(buildApp()).post('/sfx/category/rename').send('category_id=3&name=Alerts');
    expect(res.headers.location).toBe('/sfx?error=update_failed');
  });

  it('redirects with remove_failed when deleteCategory throws', async () => {
    vi.mocked(deleteCategory).mockRejectedValue(new Error('boom'));
    const res = await supertest(buildApp()).post('/sfx/category/remove').send('category_id=3');
    expect(res.headers.location).toBe('/sfx?error=remove_failed');
  });
});

// ── Access control & CSRF ─────────────────────────────────────────────────────

describe('access control', () => {
  it('mutations are gated behind requireMod', async () => {
    vi.mocked(requireMod).mockImplementationOnce((_req: any, res: any) => res.status(403).send('denied'));
    const res = await supertest(buildApp()).post('/sfx/trigger/add').send('trigger_command=!clap');
    expect(res.status).toBe(403);
    expect(vi.mocked(createSfxTrigger)).not.toHaveBeenCalled();
  });

  it('uploads run csrfProtection before Multer buffers the file', async () => {
    vi.mocked(csrfProtection).mockImplementationOnce((_req: any, res: any) => res.status(403).send('bad csrf'));
    const res = await supertest(buildApp())
      .post('/sfx/file/upload')
      .field('trigger_id', '5')
      .attach('sound', MP3_ID3, { filename: 'clap.mp3', contentType: 'audio/mpeg' });
    expect(res.status).toBe(403);
    expect(vi.mocked(fs.promises.writeFile)).not.toHaveBeenCalled();
    expect(vi.mocked(addSfxFile)).not.toHaveBeenCalled();
  });
});
