import type { Request } from 'express';

// The requests an OBS browser source makes on its own, with no login: the overlay pages' event
// streams, the shared overlay's background downloads and readiness reports, and the files a
// redemption or alert plays. A streamer's OBS can send hundreds of these in a few minutes (the
// shared overlay syncs videos in 2 MB pieces), so they get their own per-IP limit
// (`overlayTrafficLimiter`) instead of sharing the general limiter's 100 per 15 minutes with every
// other unauthenticated request from that IP (#1011). Each route also keeps its own narrower guard:
// SSE connection caps, the preload budget and per-IP cap, and the report limiter.

/** One kind of OBS overlay request: its method and full path. */
interface OverlayRoute {
  method: 'GET' | 'POST';
  path: RegExp;
}

/** `[^/]+` for a URL segment, excluding the panel's `settings` pages that share these prefixes. */
const SEGMENT = '(?!settings/)[^/]+';

const OVERLAY_ROUTES: readonly OverlayRoute[] = [
  // Event streams of the reward overlay, the alerts overlay and the shared overlay.
  { method: 'GET', path: new RegExp(`^/(?:overlay|alerts|overlay/shared)/${SEGMENT}/events$`) },
  // The shared overlay's video files (full-speed and ?preload=1) and its readiness reports.
  { method: 'GET', path: /^\/overlay\/shared\/videos\/[^/]+$/ },
  { method: 'POST', path: new RegExp(`^/overlay/shared/${SEGMENT}/report$`) },
  // A streamer's reward videos and alert images/sounds.
  { method: 'GET', path: /^\/overlay\/videos\/[^/]+\/[^/]+$/ },
  { method: 'GET', path: /^\/alerts\/assets\/[^/]+\/[^/]+$/ },
];

/**
 * Whether a request is one an OBS overlay makes by itself (see the module comment).
 * @param req - Express request; reads `method` and the full `path`.
 * @returns True for an overlay event stream, file download or readiness report.
 */
export function isOverlayTraffic(req: Request): boolean {
  return OVERLAY_ROUTES.some((route) => route.method === req.method && route.path.test(req.path));
}
