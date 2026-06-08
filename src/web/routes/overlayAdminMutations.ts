import { createLogger } from '../../shared/logger';
import { Router } from 'express';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import { randomUUID } from 'crypto';
import { csrfProtection } from '../csrf';
import { requireAuth } from '../middleware';
import type { DbStreamerEventSub } from '../../db';
import { addVideo, deleteVideo } from '../../db';
import { OVERLAY_FOLDER } from '../../shared/config';
import { parsePositiveIntId } from './shared';
import { safeResolve } from '../../shared/pathUtils';
import { requireStreamer } from './overlayAdminShared';

export { requireStreamer, toStringArray, parseWeight } from './overlayAdminShared';

const log = createLogger('OverlayAdmin');
export const router = Router();

const parsedMaxMb = parseInt(process.env.OVERLAY_MAX_FILE_MB ?? '100', 10);
/** Maximum upload size in megabytes, passed to templates to avoid direct process.env access in EJS. */
export const MAX_UPLOAD_MB = Number.isFinite(parsedMaxMb) && parsedMaxMb > 0 ? parsedMaxMb : 100;
const MAX_FILE_BYTES = MAX_UPLOAD_MB * 1024 * 1024;

export const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_FILE_BYTES },
  fileFilter: (_req, file, cb) => {
    const allowed = ['video/webm', 'video/mp4'];
    cb(null, allowed.includes(file.mimetype));
  },
});

/**
 * Detect video type from buffer magic bytes, independent of the client-supplied MIME type.
 * WebM: EBML header 0x1A 0x45 0xDF 0xA3
 * MP4: ftyp box signature at bytes 4–7: 0x66 0x74 0x79 0x70
 */
export function detectVideoType(buf: Buffer): 'webm' | 'mp4' | null {
  if (buf.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]))) {
    return 'webm';
  }
  if (buf.subarray(4, 8).equals(Buffer.from([0x66, 0x74, 0x79, 0x70]))) {
    return 'mp4';
  }
  return null;
}

async function saveVideoFile(streamer: DbStreamerEventSub, file: Express.Multer.File, name: string): Promise<void> {
  const dir = safeResolve(OVERLAY_FOLDER, String(streamer.id));
  if (!dir) throw Object.assign(new Error('Path traversal blocked'), { code: 'invalid_path' });
  const ext = detectVideoType(file.buffer);
  if (!ext) throw Object.assign(new Error('Invalid file type'), { code: 'invalid_file' });
  const filename = `${randomUUID()}.${ext}`;
  await fs.promises.mkdir(dir, { recursive: true });
  const fullPath = path.join(dir, filename);
  await fs.promises.writeFile(fullPath, file.buffer);
  try {
    await addVideo(streamer.id, name, filename);
  } catch (e) {
    await fs.promises.rm(fullPath, { force: true });
    throw e;
  }
  log.info(`Overlay video uploaded for ${streamer.twitch_name}: ${filename}`);
}

// POST /overlay/settings/videos/upload
// csrfProtection runs BEFORE upload.single so a bad token is rejected before Multer buffers the file.
// The CSRF token is passed in the URL query string (?_csrf=…) so it is available before body parsing.
router.post('/settings/videos/upload', requireAuth, csrfProtection, upload.single('video'), async (req, res) => {
  try {
    const streamer = await requireStreamer(req, res);
    if (!streamer) return;
    if (!req.file) return res.redirect('/overlay/settings?error=invalid_file');
    const name = (typeof req.body?.name === 'string' ? req.body.name.trim().slice(0, 100) : '') || req.file.originalname.trim().slice(0, 100);
    await saveVideoFile(streamer, req.file, name);
    res.redirect('/overlay/settings?success=video_uploaded');
  } catch (err: unknown) {
    const code = err instanceof Error ? (err as NodeJS.ErrnoException).code : undefined;
    if (code === 'invalid_path') return res.redirect('/overlay/settings?error=invalid_path');
    if (code === 'invalid_file') return res.redirect('/overlay/settings?error=invalid_file');
    log.error('Overlay video upload error:', err);
    res.redirect('/overlay/settings?error=upload_failed');
  }
});

// POST /overlay/settings/videos/:id/delete
router.post('/settings/videos/:id/delete', requireAuth, csrfProtection, async (req, res) => {
  try {
    const streamer = await requireStreamer(req, res);
    if (!streamer) return;

    const videoId = parsePositiveIntId(req.params.id);
    if (videoId === null) return res.redirect('/overlay/settings?error=invalid_id');

    const filename = await deleteVideo(videoId, streamer.id);
    if (filename) {
      const filePath = safeResolve(OVERLAY_FOLDER, String(streamer.id), filename);
      if (filePath) await fs.promises.rm(filePath, { force: true });
    }

    res.redirect('/overlay/settings?success=video_deleted');
  } catch (err) {
    log.error('Overlay video delete error:', err);
    res.redirect('/overlay/settings?error=delete_failed');
  }
});
