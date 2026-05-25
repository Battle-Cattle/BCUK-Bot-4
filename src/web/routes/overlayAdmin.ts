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
import {
  getVideosForStreamer, addVideo, deleteVideo,
  getRewardsForStreamer, upsertReward, setRewardVideos, deleteReward,
} from '../../db';
import { OVERLAY_FOLDER, PUBLIC_URL } from '../../config';
import { getCustomRewards, TwitchCustomReward } from '../../twitchApi';
import { getValidToken } from '../../twitchApiEventSub';
import { parsePositiveIntId } from './shared';

const log = createLogger('OverlayAdmin');
const router = Router();

const MAX_FILE_BYTES = parseInt(process.env.OVERLAY_MAX_FILE_MB ?? '100', 10) * 1024 * 1024;

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_FILE_BYTES },
  fileFilter: (_req, file, cb) => {
    const allowed = ['video/webm', 'video/mp4'];
    cb(null, allowed.includes(file.mimetype));
  },
});

/** Resolves the streamer for the logged-in user, or redirects and returns null. */
async function requireStreamer(req: Request, res: Response): Promise<DbStreamerEventSub | null> {
  const streamer = await getStreamerByDiscordId(req.session.user!.discordId);
  if (!streamer) {
    res.redirect('/overlay/settings?error=not_a_streamer');
    return null;
  }
  return streamer;
}

/** Normalises a form field that may arrive as a single string or an array of strings. */
function toStringArray(value: string | string[] | undefined): string[] {
  if (Array.isArray(value)) return value;
  return value ? [value] : [];
}

async function fetchTwitchRewards(streamer: DbStreamerEventSub): Promise<TwitchCustomReward[]> {
  if (!streamer.twitch_user_id) return [];
  const token = await getValidToken(streamer);
  if (!token) return [];
  try {
    return await getCustomRewards(streamer.twitch_user_id, token);
  } catch (err) {
    log.warn('Failed to fetch Twitch custom rewards:', err);
    return [];
  }
}

function parseWeight(raw: string | string[] | undefined): number {
  const n = Number(Array.isArray(raw) ? raw[0] : raw);
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : 1;
}

// GET /overlay/settings
router.get('/settings', requireAuth, csrfProtection, async (req, res) => {
  try {
    const streamer = await getStreamerByDiscordId(req.session.user!.discordId);
    const [videos, rewards, twitchRewards] = streamer
      ? await Promise.all([
          getVideosForStreamer(streamer.id),
          getRewardsForStreamer(streamer.id),
          fetchTwitchRewards(streamer),
        ])
      : [[], [], []];

    res.render('overlayAdmin', {
      user: req.session.user,
      csrfToken: req.csrfToken(),
      streamer: streamer ?? null,
      videos,
      rewards,
      twitchRewards,
      baseUrl: PUBLIC_URL,
      error: req.query.error as string | undefined ?? null,
      success: req.query.success as string | undefined ?? null,
    });
  } catch (err) {
    log.error('Overlay settings page error:', err);
    res.status(500).render('error', { message: 'Failed to load overlay settings.', user: req.session.user ?? null, csrfToken: '' });
  }
});

// POST /overlay/settings/videos/upload
router.post('/settings/videos/upload', requireAuth, upload.single('video'), csrfProtection, async (req, res) => {
  try {
    const streamer = await requireStreamer(req, res);
    if (!streamer) return;

    if (!req.file) return res.redirect('/overlay/settings?error=invalid_file');

    const name = (req.body?.name as string | undefined ?? '').trim().slice(0, 100) || req.file.originalname;
    const ext = req.file.mimetype === 'video/webm' ? 'webm' : 'mp4';
    const filename = `${randomUUID()}.${ext}`;

    const dir = path.join(OVERLAY_FOLDER, String(streamer.id));
    await fs.promises.mkdir(dir, { recursive: true });
    const fullPath = path.join(dir, filename);
    await fs.promises.writeFile(fullPath, req.file.buffer);
    try {
      await addVideo(streamer.id, name, filename);
    } catch (e) {
      await fs.promises.rm(fullPath, { force: true });
      throw e;
    }
    log.info(`Overlay video uploaded for ${streamer.twitch_name}: ${filename}`);
    res.redirect('/overlay/settings?success=video_uploaded');
  } catch (err) {
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
      const filePath = path.join(OVERLAY_FOLDER, String(streamer.id), filename);
      await fs.promises.rm(filePath, { force: true });
    }

    res.redirect('/overlay/settings?success=video_deleted');
  } catch (err) {
    log.error('Overlay video delete error:', err);
    res.redirect('/overlay/settings?error=delete_failed');
  }
});

// POST /overlay/settings/rewards — create or update a reward assignment
router.post('/settings/rewards', requireAuth, csrfProtection, async (req, res) => {
  try {
    const streamer = await requireStreamer(req, res);
    if (!streamer) return;

    const body = req.body as Record<string, string | string[] | undefined>;
    const twitchRewardId = (typeof body.twitch_reward_id === 'string' ? body.twitch_reward_id : '').trim();

    if (!/^[0-9a-f-]{36}$/i.test(twitchRewardId)) {
      return res.redirect('/overlay/settings?error=invalid_reward_id');
    }

    const videoIds = toStringArray(body.video_ids).map(Number).filter((n) => Number.isInteger(n) && n > 0);

    if (videoIds.length === 0) return res.redirect('/overlay/settings?error=no_videos_selected');

    const rewardId = await upsertReward(streamer.id, twitchRewardId);
    await setRewardVideos(
      rewardId,
      streamer.id,
      videoIds.map((videoId) => ({ videoId, weight: parseWeight(body[`weight_${videoId}`]) })),
    );

    res.redirect('/overlay/settings?success=reward_saved');
  } catch (err) {
    log.error('Overlay reward save error:', err);
    res.redirect('/overlay/settings?error=save_failed');
  }
});

// POST /overlay/settings/rewards/:id/delete
router.post('/settings/rewards/:id/delete', requireAuth, csrfProtection, async (req, res) => {
  try {
    const streamer = await requireStreamer(req, res);
    if (!streamer) return;

    const rewardId = parsePositiveIntId(req.params.id);
    if (rewardId === null) return res.redirect('/overlay/settings?error=invalid_id');

    await deleteReward(rewardId, streamer.id);
    res.redirect('/overlay/settings?success=reward_deleted');
  } catch (err) {
    log.error('Overlay reward delete error:', err);
    res.redirect('/overlay/settings?error=delete_failed');
  }
});

export default router;
