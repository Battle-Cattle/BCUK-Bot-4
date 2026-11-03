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

/**
 * Records an upload's latest conversion progress.
 * @param streamerId - DB row ID of the uploading streamer.
 * @param uploadId - The upload's ID.
 * @param progress - Its stage and percentage.
 */
export function setConversionProgress(streamerId: number, uploadId: string, progress: ConversionProgress): void {
  progressByUpload.set(progressKey(streamerId, uploadId), progress);
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
 * Forgets an upload's progress once its conversion has finished, either way.
 * @param streamerId - DB row ID of the uploading streamer.
 * @param uploadId - The upload's ID.
 */
export function clearConversionProgress(streamerId: number, uploadId: string): void {
  progressByUpload.delete(progressKey(streamerId, uploadId));
}
