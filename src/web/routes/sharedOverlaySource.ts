import path from 'path';
import type { Response } from 'express';
import { Router } from 'express';
import { createLogger } from '../../shared/logger';
import {
  OVERLAY_FOLDER, OVERLAY_MAX_SSE_PER_CHANNEL, SHARED_OVERLAY_MAX_LATE_SECONDS,
} from '../../shared/config';
import { listEnabledSharedVideos } from '../../db';
import { renderView } from './viewHelpers';
import { sharedOverlayReportLimiter } from '../rateLimits';
import { parseReadinessReport, recordReadinessReport } from './sharedOverlayReadiness';
import { resolveSharedFile, sendStreamerFile } from './streamerFileServing';
import { broadcastToChannel } from './sseChannel';
import { createSseEventsHandler, createLoginValidator } from './sseEventsHandlers';
import { SHARED_FOLDER } from './sharedOverlayVideoFiles';
import { servePreloadVideo } from './sharedOverlayPreload';
import { isStreamerLive } from './sharedOverlayLiveState';

// The shared video overlay (#917): a separate OBS browser source at /overlay/shared/:login that
// plays the same video on every connected streamer's stream, so it never queues behind
// channel-point videos. Mounted at /overlay/shared, ahead of overlaySource.ts.

const log = createLogger('SharedOverlaySource');
const router = Router();

const LOGIN_RE = /^[a-zA-Z0-9_]{1,25}$/;
const FILENAME_RE = /^[\w-]+\.(webm)$/i;
// Words reserved for this router's own routes (and later admin paths) — not channel logins.
const RESERVED_LOGINS = new Set(['settings', 'videos']);
const isValidLogin = createLoginValidator(LOGIN_RE, RESERVED_LOGINS);

/** In-memory map of connected shared overlays, keyed by lowercase Twitch login. */
export const sharedConnections = new Map<string, Set<Response>>();

/** URL path a shared video is served from. */
const VIDEO_URL_PREFIX = '/overlay/shared/videos/';

/** One shared video as the overlay sees it. */
interface SharedOverlayVideoEntry {
  id: number;
  name: string;
  /** URL path the video is served from. */
  url: string;
}

/**
 * URL path a shared video is served from.
 * @param filename - Stored filename of the video.
 * @returns The URL path overlays load the video from.
 */
export function sharedVideoUrl(filename: string): string {
  return VIDEO_URL_PREFIX + encodeURIComponent(filename);
}

/**
 * Lists the enabled shared videos in the shape sent to overlays.
 * @returns Enabled videos, newest first.
 */
export async function getSharedVideoEntries(): Promise<SharedOverlayVideoEntry[]> {
  const videos = await listEnabledSharedVideos();
  return videos.map((v) => ({ id: v.id, name: v.name, url: sharedVideoUrl(v.filename) }));
}

/**
 * Sends a payload to every connected shared overlay.
 * @param payload - JSON-serialisable message for the overlays.
 * @returns How many overlays were still connected after the send.
 */
export function broadcastSharedEvent(payload: unknown): number {
  let reached = 0;
  for (const login of [...sharedConnections.keys()]) {
    reached += broadcastToChannel(sharedConnections, login, payload) ?? 0;
  }
  return reached;
}

/**
 * Sends the current enabled video list to every connected shared overlay, so they catch up after a
 * Manager adds, removes, enables or disables a video without a restart.
 * @returns How many overlays were still connected after the send.
 */
export async function broadcastSharedVideoList(): Promise<number> {
  return broadcastSharedEvent({ type: 'videos', videos: await getSharedVideoEntries() });
}

/**
 * Tells every connected shared overlay to play a video at a server time.
 * @param url - URL path of the video.
 * @param playAt - Server epoch milliseconds to start playing at.
 * @returns How many overlays were reached.
 */
export function pushSharedPlay(url: string, playAt: number): number {
  return broadcastSharedEvent({ type: 'play', video: url, playAt });
}

/**
 * Counts connected shared overlays (for the admin page).
 * @returns Total open shared overlay connections.
 */
export function getSharedOverlayConnectionCount(): number {
  let total = 0;
  for (const clients of sharedConnections.values()) total += clients.size;
  return total;
}

/**
 * Sends a newly connected overlay its server time (for the clock offset), the late-start limit,
 * the enabled video list and whether its streamer is live. On a failed list lookup the connection is closed so the overlay's
 * reconnect backoff retries, rather than leaving it without a list.
 * @param res - The overlay's SSE response.
 * @param login - Lowercase Twitch login the overlay is connected for, to tell it whether they are live.
 */
async function sendInit(res: Response, login: string): Promise<void> {
  try {
    const videos = await getSharedVideoEntries();
    const init = {
      type: 'init', serverTime: Date.now(), maxLateMs: SHARED_OVERLAY_MAX_LATE_SECONDS * 1000, videos, live: isStreamerLive(login),
    };
    if (!res.writableEnded) res.write(`data: ${JSON.stringify(init)}\n\n`);
  } catch (err) {
    log.error('Failed to send shared overlay init:', err);
    res.end();
  }
}

/**
 * GET /overlay/shared/videos/:filename — serves a shared video from the shared folder (no auth;
 * filenames are unguessable and never reused). Range requests work via `sendFile`. With
 * `?preload=1` the same file is served through the shared preload speed limit instead (background
 * syncs); trigger fallbacks and Manager pushes use this route without it, at full speed.
 * @param req - Express request; reads the `filename` route param.
 * @param res - Express response; sends the file, or 400 for a malformed name / 404 if missing.
 */
router.get('/videos/:filename', async (req, res) => {
  if (req.query.preload === '1') { await servePreloadVideo(req, res); return; }
  const folder = path.resolve(OVERLAY_FOLDER, SHARED_FOLDER);
  const file = await resolveSharedFile(res, folder, req.params.filename, FILENAME_RE);
  if (file) sendStreamerFile(res, file.realPath);
});

/**
 * GET /overlay/shared/:login — renders the shared overlay browser source page.
 * @param req - Express request; reads the `login` route param.
 * @param res - Express response; renders `sharedOverlaySource`, or falls through via `next()`
 *   for a malformed or reserved login.
 */
router.get('/:login', (req, res, next) => {
  const login = isValidLogin(req.params.login);
  if (login === null) { next(); return; }
  renderView(res, 'sharedOverlaySource', { login });
});

/**
 * POST /overlay/shared/:login/report — an overlay reports which shared videos it has stored and its
 * current download, for the admin page's readiness stats. No login (OBS can't log in), so it is
 * rate-limited per overlay, accepts only ids on the current list, and only for a login that has a
 * shared overlay connected right now. The stats are self-reported and only drive what the admin
 * page shows, never what plays.
 * @param req - Express request; JSON body `{ stored: number[], downloading: {id, percent} | null }`.
 * @param res - 204 when recorded; 404 for a malformed login or one with no connected overlay; 400
 *   for a malformed report or an id not on the list; 500 if the list can't be read.
 */
router.post('/:login/report', sharedOverlayReportLimiter, async (req, res) => {
  const login = isValidLogin(String(req.params.login));
  if (login === null || !sharedConnections.get(login)?.size) { res.status(404).end(); return; }
  try {
    const validIds = new Set((await getSharedVideoEntries()).map((v) => v.id));
    const report = parseReadinessReport(req.body, validIds);
    if (!report) { res.status(400).end(); return; }
    recordReadinessReport(login, report);
    res.status(204).end();
  } catch (err) {
    log.error('Failed to record shared overlay report:', err);
    res.status(500).end();
  }
});

/**
 * GET /overlay/shared/:login/events — SSE stream for a shared overlay. Sends `init` on connect,
 * then whatever {@link broadcastSharedEvent} pushes. Unauthenticated overlay pool and per-channel
 * limit, like the reward-video overlay.
 */
router.get('/:login/events', createSseEventsHandler({
  connections: sharedConnections,
  isValidLogin,
  maxPerChannel: OVERLAY_MAX_SSE_PER_CHANNEL,
  onConnected: sendInit,
}));

export default router;
