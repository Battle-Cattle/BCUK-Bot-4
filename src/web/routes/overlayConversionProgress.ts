// Where an overlay MOV upload's conversion has got to, so the settings page can show it while
// the upload request is still waiting. The page tags each upload with a random ID (the
// `X-Upload-Id` header) and polls `GET /overlay/settings/videos/progress/:uploadId` for it.
// Entries live only while their upload is converting, and at most a few convert at once (see
// `MAX_PENDING_WEBM_TRANSCODES`), so the map stays tiny.

/** A conversion's stage: waiting behind another conversion, or being encoded. */
type ConversionStage = 'queued' | 'converting';

/** What the progress endpoint reports for one upload. */
export interface ConversionProgress {
  /** Whether the conversion is waiting for its turn or running. */
  stage: ConversionStage;
  /** Whole-number percentage encoded so far, or null while it isn't known yet. */
  percent: number | null;
}

/** An upload ID as the settings page generates it: 16 random bytes in lowercase hex. */
const UPLOAD_ID_RE = /^[0-9a-f]{32}$/;

/** Progress of the conversions running now, keyed by {@link progressKey}. */
const progressByUpload = new Map<string, ConversionProgress>();

/**
 * Checks an upload ID taken from a request, so only well-formed IDs are ever stored or looked up.
 * @param value - The raw header or route-parameter value.
 * @returns The ID when it's 32 lowercase hex characters, otherwise null.
 */
export function parseUploadId(value: unknown): string | null {
  return typeof value === 'string' && UPLOAD_ID_RE.test(value) ? value : null;
}

/**
 * Builds the map key for an upload, scoping it to its streamer so one streamer can never read
 * another's progress, even with the other's upload ID.
 * @param streamerId - DB row ID of the uploading streamer.
 * @param uploadId - The upload's ID (already checked with {@link parseUploadId}).
 * @returns The map key.
 */
function progressKey(streamerId: number, uploadId: string): string {
  return `${streamerId}:${uploadId}`;
}

/** The request that owns each upload's progress entry, keyed by {@link progressKey}. */
const ownerByUpload = new Map<string, symbol>();

/**
 * Claims an upload's progress entry for the calling request. Synchronous, so two requests sending
 * the same upload ID can't both claim it; the one that doesn't get it simply isn't tracked.
 * @param streamerId - DB row ID of the uploading streamer.
 * @param uploadId - The upload's ID.
 * @returns The owner token to pass to {@link setConversionProgress} and
 *   {@link releaseConversionProgress}, or null when another request already holds the entry.
 */
export function claimConversionProgress(streamerId: number, uploadId: string): symbol | null {
  const key = progressKey(streamerId, uploadId);
  if (ownerByUpload.has(key)) return null;
  const owner = Symbol(key);
  ownerByUpload.set(key, owner);
  return owner;
}

/**
 * Records an upload's latest conversion progress, if `owner` holds its entry.
 * @param streamerId - DB row ID of the uploading streamer.
 * @param uploadId - The upload's ID.
 * @param owner - The token from {@link claimConversionProgress}.
 * @param progress - Its stage and percentage.
 */
export function setConversionProgress(streamerId: number, uploadId: string, owner: symbol, progress: ConversionProgress): void {
  const key = progressKey(streamerId, uploadId);
  if (ownerByUpload.get(key) === owner) progressByUpload.set(key, progress);
}

/**
 * Looks up an upload's conversion progress.
 * @param streamerId - DB row ID of the streamer asking.
 * @param uploadId - The upload's ID.
 * @returns Its progress, or undefined when that streamer has no conversion with that ID running.
 */
export function getConversionProgress(streamerId: number, uploadId: string): ConversionProgress | undefined {
  return progressByUpload.get(progressKey(streamerId, uploadId));
}

/**
 * Forgets an upload's progress once its conversion has finished, either way. Does nothing unless
 * `owner` still holds the entry.
 * @param streamerId - DB row ID of the uploading streamer.
 * @param uploadId - The upload's ID.
 * @param owner - The token from {@link claimConversionProgress}.
 */
export function releaseConversionProgress(streamerId: number, uploadId: string, owner: symbol): void {
  const key = progressKey(streamerId, uploadId);
  if (ownerByUpload.get(key) !== owner) return;
  ownerByUpload.delete(key);
  progressByUpload.delete(key);
}
