import { createLogger } from '../../logger';
import { Router } from 'express';
import type { Request, Response } from 'express';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import { randomUUID } from 'crypto';
import { csrfProtection } from '../csrf';
import { requireAuth } from '../middleware';
import { getStreamerByDiscordId } from '../../db';
import type { DbStreamerEventSub } from '../../db';
import { addVideo, deleteVideo } from '../../db';
import { OVERLAY_FOLDER } from '../../config';
import { parsePositiveIntId } from './shared';
import { safeResolve } from '../../pathUtils';
import { router as rewardRouter } from './overlayAdminRewardMutations';

const log = createLogger('OverlayAdmin');
export const router = Router();

const parsedMaxMb = parseInt(process.env.OVERLAY_MAX_FILE_MB ?? '100', 10);
const MAX_FILE_BYTES = (Number.isFinite(parsedMaxMb) && parsedMaxMb > 0 ? parsedMaxMb : 100) * 1024 * 1024;

export const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_FILE_BYTES },
  fileFilter: (_req, file, cb) => {
    const allowed = ['video/webm', 'video/mp4'];
    cb(null, allowed.includes(file.mimetype));
  },
});

/** Resolves the streamer for the logged-in user, or redirects and returns null. */
export async function requireStreamer(req: Request, res: Response): Promise<DbStreamerEventSub | null> {
  const streamer = await getStreamerByDiscordId(req.session.user!.discordId);
  if (!streamer) {
    res.redirect('/overlay/settings?error=not_a_streamer');
    return null;
  }
  return streamer;
}

/** Normalises a form field that may arrive as a single string or an array of strings. */
export function toStringArray(value: string | string[] | undefined): string[] {
  if (Array.isArray(value)) return value;
  return value ? [value] : [];
}

export function parseWeight(raw: string | string[] | undefined): number {
  const n = Number(Array.isArray(raw) ? raw[0] : raw);
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : 1;
}

async function saveVideoFile(streamer: DbStreamerEventSub, file: Express.Multer.File, name: string): Promise<void> {
  const dir = safeResolve(OVERLAY_FOLDER, String(streamer.id));
  if (!dir) throw Object.assign(new Error('Path traversal blocked'), { code: 'invalid_path' });
  const ext = file.mimetype === 'video/webm' ? 'webm' : 'mp4';
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
router.post('/settings/videos/upload', requireAuth, upload.single('video'), csrfProtection, async (req, res) => {
  try {
    const streamer = await requireStreamer(req, res);
    if (!streamer) return;
    if (!req.file) return res.redirect('/overlay/settings?error=invalid_file');
    const name = (typeof req.body?.name === 'string' ? req.body.name.trim().slice(0, 100) : '') || req.file.originalname;
    await saveVideoFile(streamer, req.file, name);
    res.redirect('/overlay/settings?success=video_uploaded');
  } catch (err: any) {
    if (err?.code === 'invalid_path') return res.redirect('/overlay/settings?error=invalid_path');
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

router.use(rewardRouter);
