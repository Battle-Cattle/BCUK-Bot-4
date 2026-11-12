// In-memory readiness of the shared overlays (#917): which shared videos each overlay says it has
// stored, and how far its current download has got. Single-instance by design (a bot restart
// loses it; overlays reconnect and report again). Overlays report themselves, so this only drives
// what the admin page shows, never what plays.

/** What an overlay reports: the shared video ids it has stored and its current download. */
export interface ReadinessReport {
  /** Ids of the videos stored in full. */
  stored: number[];
  /** The video being downloaded now and how far along it is (0–100), or null. */
  downloading: { id: number; percent: number } | null;
}

/** Most ids one report may carry, a sanity bound well above any real shared list. */
const MAX_REPORTED_IDS = 1000;

interface StoredReport extends ReadinessReport {
  /** Epoch ms the report was received. */
  reportedAt: number;
}

const reports = new Map<string, StoredReport>();
const listeners = new Set<() => void>();

/**
 * Checks the `downloading` part of a report.
 * @param downloading - The untrusted value; null or undefined means nothing is downloading.
 * @param validIds - Ids of the currently enabled shared videos.
 * @returns The download, null for none, or undefined if it is malformed or names an unlisted id.
 */
function parseDownloading(downloading: unknown, validIds: ReadonlySet<number>): ReadinessReport['downloading'] | undefined {
  if (downloading === null || downloading === undefined) return null;
  const { id, percent } = downloading as { id?: unknown; percent?: unknown };
  if (typeof id !== 'number' || !validIds.has(id)) return undefined;
  if (typeof percent !== 'number' || !Number.isFinite(percent) || percent < 0 || percent > 100) return undefined;
  return { id, percent: Math.round(percent) };
}

/**
 * Checks a report body: well-formed, and every id on the current list.
 * @param body - The untrusted request body.
 * @param validIds - Ids of the currently enabled shared videos.
 * @returns The report, or null if malformed or naming an id that is not on the list.
 */
export function parseReadinessReport(body: unknown, validIds: ReadonlySet<number>): ReadinessReport | null {
  if (typeof body !== 'object' || body === null) return null;
  const { stored, downloading } = body as { stored?: unknown; downloading?: unknown };
  if (!Array.isArray(stored) || stored.length > MAX_REPORTED_IDS) return null;
  if (!stored.every((id): id is number => typeof id === 'number' && validIds.has(id))) return null;
  const current = parseDownloading(downloading, validIds);
  return current === undefined ? null : { stored: [...new Set(stored)], downloading: current };
}

/**
 * Stores an overlay's latest report, replacing its previous one, and tells the listeners.
 * @param login - Lowercase Twitch login of the overlay.
 * @param report - The validated report.
 * @param now - Receive time in epoch ms (defaults to now).
 */
export function recordReadinessReport(login: string, report: ReadinessReport, now: number = Date.now()): void {
  reports.set(login, { ...report, reportedAt: now });
  for (const listener of listeners) listener();
}

/**
 * Subscribes to report changes.
 * @param listener - Called after every recorded report.
 * @returns An unsubscribe function.
 */
export function onReadinessChange(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/** One overlay's row in the admin view. */
interface OverlayReadiness {
  login: string;
  /** Whether it has a shared overlay connection open right now. */
  online: boolean;
  /** Videos on the current list it has stored. */
  stored: number;
  /** Videos on the current list. */
  total: number;
  /** The video it is downloading now, or null. */
  downloading: { id: number; name: string; percent: number } | null;
  /** Epoch ms of its last report, or null if it has not reported since the bot started. */
  reportedAt: number | null;
}

/** One video's row in the admin view, counted over the overlays connected now. */
interface VideoReadiness {
  id: number;
  name: string;
  /** Connected overlays that have it stored. */
  ready: number;
  /** Connected overlays. */
  online: number;
  /** Connected overlays that lack it, with their download percentage when downloading it. */
  missing: Array<{ login: string; percent: number | null }>;
  /** True when every connected overlay (at least one) has it. */
  allReady: boolean;
}

/** What the admin page shows. */
export interface ReadinessSnapshot {
  overlays: OverlayReadiness[];
  videos: VideoReadiness[];
}

/**
 * Builds one overlay's row.
 * @param login - The overlay's login.
 * @param online - Whether it is connected.
 * @param videos - The current enabled list.
 * @param report - Its last report, if any.
 * @returns The overlay's row.
 */
function overlayRow(
  login: string, online: boolean, videos: ReadonlyArray<{ id: number; name: string }>, report: StoredReport | undefined,
): OverlayReadiness {
  const onList = new Set(videos.map((v) => v.id));
  const downloadingVideo = report?.downloading ? videos.find((v) => v.id === report.downloading?.id) : undefined;
  return {
    login,
    online,
    stored: (report?.stored ?? []).filter((id) => onList.has(id)).length,
    total: videos.length,
    downloading: downloadingVideo && report?.downloading
      ? { id: downloadingVideo.id, name: downloadingVideo.name, percent: report.downloading.percent }
      : null,
    reportedAt: report?.reportedAt ?? null,
  };
}

/**
 * Builds a video's row over the connected overlays.
 * @param video - The video.
 * @param onlineLogins - Logins of the connected overlays, sorted.
 * @returns The video's row.
 */
function videoRow(video: { id: number; name: string }, onlineLogins: readonly string[]): VideoReadiness {
  const missing: VideoReadiness['missing'] = [];
  for (const login of onlineLogins) {
    const report = reports.get(login);
    if (report?.stored.includes(video.id)) continue;
    missing.push({ login, percent: report?.downloading?.id === video.id ? report.downloading.percent : null });
  }
  const ready = onlineLogins.length - missing.length;
  return { id: video.id, name: video.name, ready, online: onlineLogins.length, missing, allReady: ready === onlineLogins.length && ready > 0 };
}

/**
 * Builds the admin view from the stored reports: every connected overlay plus the offline ones
 * that reported earlier (their last report kept, so "OBS isn't open" can be told apart from
 * "hasn't downloaded it"), and every video's readiness over the connected overlays.
 * @param videos - The current enabled list.
 * @param onlineLogins - Lowercase logins with a shared overlay connected right now.
 * @returns The snapshot.
 */
export function getReadinessSnapshot(
  videos: ReadonlyArray<{ id: number; name: string }>,
  onlineLogins: ReadonlySet<string>,
): ReadinessSnapshot {
  const logins = [...new Set([...onlineLogins, ...reports.keys()])].sort();
  const online = logins.filter((l) => onlineLogins.has(l));
  return {
    overlays: logins.map((l) => overlayRow(l, onlineLogins.has(l), videos, reports.get(l))),
    videos: videos.map((v) => videoRow(v, online)),
  };
}

/**
 * Clears every report (listeners stay subscribed). Exported for tests only.
 */
export function resetReadiness(): void {
  reports.clear();
}
