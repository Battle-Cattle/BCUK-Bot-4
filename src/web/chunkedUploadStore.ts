import fs from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';
import { createLogger } from '../shared/logger';

// Upload sessions for chunked, resumable uploads (issue #912): a file arrives as a run of short
// requests, each appending one piece at the offset the server has confirmed so far, instead of one
// long multipart POST. A session's state lives on disk beside its data — `<id>.json` holds who
// started it and what they declared, `<id>.part` the bytes received so far (its size is the
// confirmed offset, its mtime the last activity) — so nothing depends on which process handled
// the previous piece. Each upload area (overlay videos, SFX, alert assets) gets its own store,
// with its own folder and size limit, and keeps its own type checks for when the upload finishes.

const log = createLogger('ChunkedUploadStore');

/**
 * Largest piece a client may send in one request. A 500 MB overlay is about 63 pieces, well
 * inside `sessionLimiter`'s 600 requests per 15 minutes, and a reverse proxy only needs a body
 * limit above this.
 */
export const CHUNK_MAX_BYTES = 8 * 1024 * 1024;

/** An upload with no piece received for this long is abandoned: it's rejected and swept. */
const UPLOAD_SESSION_TTL_MS = 60 * 60_000;

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

/** Session state stored in `<id>.json`. */
interface UploadSessionMeta extends ChunkedUploadDeclaration {
  /** Discord ID of the user who started the upload. */
  owner: string;
}

/** Reasons a store operation is refused. */
export type ChunkedUploadError =
  | 'invalid_upload'
  | 'file_too_large'
  | 'upload_busy'
  | 'not_found'
  | 'bad_offset'
  | 'incomplete';

/** A refused operation; `received` is the confirmed offset when the session exists. */
export interface ChunkedUploadFailure {
  ok: false;
  error: ChunkedUploadError;
  /** Bytes the server holds, so the client can resume from there (for `bad_offset`). */
  received?: number;
  /** ID of the caller's upload already in progress (for `upload_busy`). */
  activeId?: string;
}

/** A finished upload, moved out of the session for the area's pipeline to check and store. */
export interface FinishedChunkedUpload extends ChunkedUploadDeclaration {
  /** Absolute path of the assembled file. The caller must move or remove it. */
  path: string;
}

/** Options for {@link createChunkedUploadStore}. */
export interface ChunkedUploadStoreOptions {
  /** Folder that holds this area's sessions; created when needed. */
  dir: string;
  /** Largest total size this area accepts, in bytes. */
  maxBytes: number;
  /** Idle time before a session expires (defaults to {@link UPLOAD_SESSION_TTL_MS}). */
  ttlMs?: number;
  /** Current time in epoch milliseconds (injectable for tests). */
  now?: () => number;
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

/** A session as read from disk: its declared state and the bytes confirmed so far. */
interface LoadedSession {
  meta: UploadSessionMeta;
  received: number;
}

/**
 * The session store for one upload area (see the file comment). Every operation takes the
 * requester's Discord ID, and another user's session reads as missing, never as forbidden.
 */
export class ChunkedUploadStore {
  private readonly dir: string;
  private readonly maxBytes: number;
  private readonly ttlMs: number;
  private readonly now: () => number;
  /** Pending work per session, so pieces for one upload are handled one at a time. */
  private readonly queues = new Map<string, Promise<unknown>>();

  /**
   * @param options - See {@link ChunkedUploadStoreOptions}.
   */
  constructor(options: ChunkedUploadStoreOptions) {
    this.dir = options.dir;
    this.maxBytes = options.maxBytes;
    this.ttlMs = options.ttlMs ?? UPLOAD_SESSION_TTL_MS;
    this.now = options.now ?? Date.now;
  }

  /**
   * Starts an upload, once the size fits this area and the user has no other upload running.
   * @param owner - Discord ID of the requester.
   * @param declared - The checked declaration (see {@link parseDeclaration}).
   * @returns The new upload ID, or why it was refused (`upload_busy` names the running one).
   */
  async start(owner: string, declared: ChunkedUploadDeclaration): Promise<{ ok: true; id: string } | ChunkedUploadFailure> {
    if (declared.size > this.maxBytes) return { ok: false, error: 'file_too_large' };
    const activeId = await this.findActive(owner);
    if (activeId) return { ok: false, error: 'upload_busy', activeId };
    const id = randomUUID();
    const meta: UploadSessionMeta = { ...declared, owner };
    await fs.promises.mkdir(this.dir, { recursive: true });
    await fs.promises.writeFile(this.partPath(id), Buffer.alloc(0), { flag: 'wx' });
    await fs.promises.writeFile(this.metaPath(id), JSON.stringify(meta), { flag: 'wx' });
    await this.touch(id);
    return { ok: true, id };
  }

  /**
   * Reports how much of an upload has arrived, so the page can resume it.
   * @param owner - Discord ID of the requester.
   * @param id - Upload ID from the request (untrusted).
   * @returns The confirmed offset and declared size, or `not_found`.
   */
  async status(owner: string, id: string): Promise<{ ok: true; received: number; size: number } | ChunkedUploadFailure> {
    const session = await this.loadOwned(owner, id);
    if (!session) return { ok: false, error: 'not_found' };
    return { ok: true, received: session.received, size: session.meta.size };
  }

  /**
   * Appends one piece, which must start exactly at the confirmed offset (no gaps or overlaps)
   * and stay within the declared size.
   * @param owner - Discord ID of the requester.
   * @param id - Upload ID from the request (untrusted).
   * @param offset - Where the client says this piece starts.
   * @param chunk - The piece's bytes.
   * @returns The new confirmed offset, or why the piece was refused.
   */
  append(owner: string, id: string, offset: number, chunk: Buffer): Promise<{ ok: true; received: number } | ChunkedUploadFailure> {
    return this.serialise(id, async () => {
      const session = await this.loadOwned(owner, id);
      if (!session) return { ok: false, error: 'not_found' } as const;
      if (offset !== session.received || chunk.length === 0) {
        return { ok: false, error: 'bad_offset', received: session.received } as const;
      }
      if (offset + chunk.length > session.meta.size) return { ok: false, error: 'file_too_large' } as const;
      await fs.promises.appendFile(this.partPath(id), chunk);
      await this.touch(id);
      return { ok: true, received: offset + chunk.length } as const;
    });
  }

  /**
   * Ends a complete upload: its file is moved out of the session and handed to the caller,
   * which runs the area's checks and must move or remove it.
   * @param owner - Discord ID of the requester.
   * @param id - Upload ID from the request (untrusted).
   * @returns The assembled file and its declaration, or `not_found`/`incomplete`.
   */
  finish(owner: string, id: string): Promise<({ ok: true } & FinishedChunkedUpload) | ChunkedUploadFailure> {
    return this.serialise(id, async () => {
      const session = await this.loadOwned(owner, id);
      if (!session) return { ok: false, error: 'not_found' } as const;
      if (session.received !== session.meta.size) {
        return { ok: false, error: 'incomplete', received: session.received } as const;
      }
      // Renamed out of the session first, so a repeated finish can't hand the file out twice.
      const assembled = path.join(this.dir, `${id}.done`);
      await fs.promises.rename(this.partPath(id), assembled);
      await this.remove(id);
      const { name, size, type } = session.meta;
      return { ok: true, path: assembled, name, size, type } as const;
    });
  }

  /**
   * Abandons an upload and removes what has arrived.
   * @param owner - Discord ID of the requester.
   * @param id - Upload ID from the request (untrusted).
   * @returns True if the requester's upload existed and was removed.
   */
  cancel(owner: string, id: string): Promise<boolean> {
    return this.serialise(id, async () => {
      if (!(await this.loadOwned(owner, id))) return false;
      await this.remove(id);
      return true;
    });
  }

  /**
   * Removes every file in this area's folder idle for longer than the session lifetime:
   * abandoned sessions and finished files whose caller failed to remove them.
   * @returns Resolves once the sweep has finished; never rejects.
   */
  async sweep(): Promise<void> {
    let names: string[];
    try {
      names = await fs.promises.readdir(this.dir);
    } catch {
      return;
    }
    const cutoff = this.now() - this.ttlMs;
    // One at a time, so a large backlog can't crowd other filesystem work out of the threadpool.
    for (const name of names) {
      const full = path.join(this.dir, name);
      try {
        if ((await fs.promises.stat(full)).mtimeMs < cutoff) await fs.promises.rm(full, { force: true });
      } catch (err) {
        log.warn(`Failed to sweep stale upload session file ${full}:`, err);
      }
    }
  }

  /**
   * @param id - Upload ID (already validated).
   * @returns Path of the session's state file.
   */
  private metaPath(id: string): string {
    return path.join(this.dir, `${id}.json`);
  }

  /**
   * @param id - Upload ID (already validated).
   * @returns Path of the session's data file.
   */
  private partPath(id: string): string {
    return path.join(this.dir, `${id}.part`);
  }

  /**
   * Runs `task` after any earlier work on the same session, so two pieces can't both pass the
   * offset check before either is written.
   * @param id - Upload ID.
   * @param task - The work to run.
   * @returns What `task` returns.
   */
  private serialise<T>(id: string, task: () => Promise<T>): Promise<T> {
    const previous = this.queues.get(id) ?? Promise.resolve();
    const run = previous.then(task, task);
    const settled = run.catch(() => undefined);
    this.queues.set(id, settled);
    void settled.then(() => {
      if (this.queues.get(id) === settled) this.queues.delete(id);
    });
    return run;
  }

  /**
   * Reads a session's state and confirmed size, if it exists and hasn't expired.
   * @param id - Upload ID (already validated).
   * @returns The session, or null when it's missing, unreadable or expired.
   */
  private async load(id: string): Promise<LoadedSession | null> {
    try {
      const [raw, stat] = await Promise.all([
        fs.promises.readFile(this.metaPath(id), 'utf8'),
        fs.promises.stat(this.partPath(id)),
      ]);
      if (this.now() - stat.mtimeMs > this.ttlMs) return null;
      return { meta: JSON.parse(raw) as UploadSessionMeta, received: stat.size };
    } catch {
      return null;
    }
  }

  /**
   * Loads a session for `owner`: another user's session reads as missing.
   * @param owner - Discord ID of the requester.
   * @param id - Upload ID from the request (untrusted).
   * @returns The session, or null.
   */
  private async loadOwned(owner: string, id: string): Promise<LoadedSession | null> {
    if (!isUploadId(id)) return null;
    const session = await this.load(id);
    return session?.meta.owner === owner ? session : null;
  }

  /**
   * Stamps both of a session's files with the current time: the data file's mtime is its last
   * activity, and keeping the state file as fresh means the sweep never splits a live session.
   * @param id - Upload ID (already validated).
   * @returns Resolves once both files are stamped.
   */
  private async touch(id: string): Promise<void> {
    const stamp = new Date(this.now());
    await Promise.all([this.metaPath(id), this.partPath(id)].map((p) => fs.promises.utimes(p, stamp, stamp)));
  }

  /**
   * Removes a session's files.
   * @param id - Upload ID (already validated).
   * @returns Resolves once both files are gone; never rejects.
   */
  private async remove(id: string): Promise<void> {
    await Promise.all([this.metaPath(id), this.partPath(id)].map((p) => fs.promises.rm(p, { force: true }).catch((err: unknown) => {
      log.warn(`Failed to remove upload session file ${p}:`, err);
    })));
  }

  /**
   * Finds `owner`'s live upload in this area, if any: each user gets one upload at a time.
   * @param owner - Discord ID of the requester.
   * @returns The upload's ID, or null.
   */
  private async findActive(owner: string): Promise<string | null> {
    let names: string[];
    try {
      names = await fs.promises.readdir(this.dir);
    } catch {
      return null;
    }
    for (const name of names) {
      const id = name.endsWith('.json') ? name.slice(0, -'.json'.length) : '';
      if (isUploadId(id) && (await this.load(id))?.meta.owner === owner) return id;
    }
    return null;
  }
}
