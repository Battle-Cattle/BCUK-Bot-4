import path from 'path';

// What a client declares when it starts a chunked upload, and the upload IDs it gets back:
// checked here before either reaches the session store (chunkedUploadStore.ts) or a path.

/** Upload IDs are UUIDs; anything else is rejected before it's used in a path. */
const UPLOAD_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Longest file name a client may declare. */
const MAX_NAME_LENGTH = 255;

/** Longest MIME type a client may declare. */
const MAX_TYPE_LENGTH = 127;

/** What the client declares when it starts an upload. */
export interface ChunkedUploadDeclaration {
  /** The file's original name. */
  name: string;
  /** Total size in bytes. */
  size: number;
  /** The MIME type the browser reported (may be empty). */
  type: string;
}

/**
 * Checks a client's declaration: a non-empty name and a whole, positive size.
 * @param declared - The declaration from the start request (untrusted).
 * @returns The cleaned declaration, or null when it's malformed.
 */
export function parseDeclaration(declared: unknown): ChunkedUploadDeclaration | null {
  if (typeof declared !== 'object' || declared === null) return null;
  const { name, size, type } = declared as Record<string, unknown>;
  const sizeNumber = typeof size === 'string' ? Number(size) : size;
  if (typeof name !== 'string' || name.length === 0 || name.length > MAX_NAME_LENGTH) return null;
  if (typeof sizeNumber !== 'number' || !Number.isSafeInteger(sizeNumber) || sizeNumber <= 0) return null;
  const typeString = typeof type === 'string' ? type : '';
  if (typeString.length > MAX_TYPE_LENGTH) return null;
  return { name: path.basename(name), size: sizeNumber, type: typeString };
}

/**
 * True for a well-formed upload ID, the only kind ever joined into a path.
 * @param id - Upload ID from the request.
 * @returns Whether `id` is a lowercase UUID.
 */
export function isUploadId(id: unknown): id is string {
  return typeof id === 'string' && UPLOAD_ID_RE.test(id);
}
