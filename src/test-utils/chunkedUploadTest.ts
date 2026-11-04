import { randomUUID } from 'crypto';
import supertest from 'supertest';
import type { Response as SupertestResponse } from 'supertest';
import type {
  ChunkedUploadDeclaration, ChunkedUploadFailure, ChunkedUploadStoreOptions, FinishedChunkedUpload,
} from '../web/chunkedUploadStore';
import type { UploadedFile } from '../web/uploadedFile';

// Test doubles for the upload areas' route tests, which drive each area's real chunked-upload
// routes without a disk (their `fs` is mocked). Mock the store and the in-memory hand-over with:
//
//   vi.mock('../chunkedUploadStore', async (importOriginal) =>
//     (await import('../../test-utils/chunkedUploadTest')).mockChunkedUploadStoreModule(await importOriginal()));
//   vi.mock('./chunkedUploadRoutes', async (importOriginal) =>
//     (await import('../../test-utils/chunkedUploadTest')).mockChunkedUploadRoutesModule(await importOriginal()));
//
// then send an upload with `uploadRequest(app).post(url).field(...).attach(...)`, which runs the
// start and complete routes and resolves with the complete (or refused start) response. The real
// store and routes have their own tests (chunkedUploadStore.test.ts, chunkedUploadRoutes.test.ts).

/** Bytes of each fake upload, by upload ID, between `start` and `finish`. */
const pendingBytes = new Map<string, Buffer>();
/** Declarations of each fake upload, by upload ID. */
const declarations = new Map<string, ChunkedUploadDeclaration>();

/** An in-memory stand-in for `ChunkedUploadStore`: pieces arrive all at once via {@link uploadRequest}. */
export class FakeChunkedUploadStore {
  readonly maxBytes: number;

  /**
   * @param options - The area's store options; only the size limit is used.
   */
  constructor(options: ChunkedUploadStoreOptions) {
    this.maxBytes = options.maxBytes;
  }

  /**
   * Starts a fake upload, refusing one over the size limit like the real store.
   * @param _owner - Discord ID of the requester (unused).
   * @param declared - The upload's declaration.
   * @returns A new upload ID, or `file_too_large`.
   */
  async start(_owner: string, declared: ChunkedUploadDeclaration): Promise<{ ok: true; id: string } | ChunkedUploadFailure> {
    if (declared.size > this.maxBytes) return { ok: false, error: 'file_too_large' };
    const id = randomUUID();
    declarations.set(id, declared);
    return { ok: true, id };
  }

  /**
   * Finishes a fake upload whose bytes {@link uploadRequest} registered.
   * @param _owner - Discord ID of the requester (unused).
   * @param id - The upload ID.
   * @returns The finished upload (its `path` is the ID), or `not_found`.
   */
  async finish(_owner: string, id: string): Promise<({ ok: true } & FinishedChunkedUpload) | ChunkedUploadFailure> {
    const declared = declarations.get(id);
    if (!declared || !pendingBytes.has(id)) return { ok: false, error: 'not_found' };
    declarations.delete(id);
    return { ok: true, path: id, ...declared };
  }

  /**
   * Not used by the area tests.
   * @returns Always `not_found`.
   */
  async status(): Promise<ChunkedUploadFailure> {
    return { ok: false, error: 'not_found' };
  }

  /**
   * Not used by the area tests.
   * @returns Always `not_found`.
   */
  async append(): Promise<ChunkedUploadFailure> {
    return { ok: false, error: 'not_found' };
  }

  /**
   * Not used by the area tests.
   * @returns Always false.
   */
  async cancel(): Promise<boolean> {
    return false;
  }

  /**
   * Nothing to sweep in memory.
   * @returns Resolves at once.
   */
  async sweep(): Promise<void> {}
}

/**
 * The fake hand-over: turns a finished fake upload into an in-memory `req.file`.
 * @param finished - What {@link FakeChunkedUploadStore.finish} returned.
 * @param field - Name of the form's file field.
 * @returns The file record, with `buffer` set.
 */
export async function fakeToMemoryFile(finished: FinishedChunkedUpload, field: string): Promise<UploadedFile> {
  const buffer = pendingBytes.get(finished.path) ?? Buffer.alloc(0);
  pendingBytes.delete(finished.path);
  return { fieldname: field, originalname: finished.name, mimetype: finished.type, size: buffer.length, buffer, filename: '', path: '' };
}

/**
 * Builds the `vi.mock` factory result for `chunkedUploadStore`.
 * @param actual - The real module.
 * @returns The real module with {@link FakeChunkedUploadStore} in place of the store.
 */
export function mockChunkedUploadStoreModule<T extends object>(actual: T): T {
  return { ...actual, ChunkedUploadStore: FakeChunkedUploadStore };
}

/**
 * Builds the `vi.mock` factory result for `chunkedUploadRoutes`.
 * @param actual - The real module.
 * @returns The real module with {@link fakeToMemoryFile} in place of `toMemoryFile`.
 */
export function mockChunkedUploadRoutesModule<T extends object>(actual: T): T {
  return { ...actual, toMemoryFile: fakeToMemoryFile };
}

/** The file part of an upload, as `attach` takes it. */
interface Attachment {
  buffer: Buffer;
  filename: string;
  contentType: string;
}

/** A supertest-like builder for one upload through an area's chunked-upload routes. */
class UploadRequest implements PromiseLike<SupertestResponse> {
  private readonly fields: Record<string, string> = {};
  private readonly headers: Record<string, string> = {};
  private file: Attachment | null = null;

  /**
   * @param app - The Express app (or server) under test.
   * @param url - The area's upload path.
   */
  constructor(private readonly app: Parameters<typeof supertest>[0], private readonly url: string) {}

  /**
   * Adds a form field, sent with the complete request.
   * @param name - Field name.
   * @param value - Field value.
   * @returns This builder.
   */
  field(name: string, value: string): this {
    this.fields[name] = value;
    return this;
  }

  /**
   * Adds a header, sent with every request.
   * @param name - Header name.
   * @param value - Header value.
   * @returns This builder.
   */
  set(name: string, value: string): this {
    this.headers[name] = value;
    return this;
  }

  /**
   * Sets the file to upload.
   * @param _field - The form's file field (each area's routes set it themselves).
   * @param buffer - The file's bytes.
   * @param options - The file name, or its name and MIME type.
   * @returns This builder.
   */
  attach(_field: string, buffer: Buffer, options: string | { filename?: string; contentType?: string } = {}): this {
    const opts = typeof options === 'string' ? { filename: options } : options;
    this.file = { buffer, filename: opts.filename ?? 'file', contentType: opts.contentType ?? '' };
    return this;
  }

  /**
   * Resolves with the response once it has the expected status, like supertest's `expect(status)`.
   * @param status - The expected HTTP status.
   * @returns The response.
   */
  async expect(status: number): Promise<SupertestResponse> {
    const res = await this.run();
    if (res.status !== status) throw new Error(`expected ${status}, got ${res.status} (${res.headers.location ?? res.text})`);
    return res;
  }

  /**
   * Starts the upload (unless no file was attached), then completes it with the fields.
   * @returns The complete response, or the refused start's response.
   */
  private async run(): Promise<SupertestResponse> {
    let id = '00000000-0000-4000-8000-000000000000';
    if (this.file) {
      const started = await supertest(this.app).post(`${this.url}/start`).set(this.headers).type('form')
        .send({ name: this.file.filename, size: String(this.file.buffer.length), type: this.file.contentType });
      if (started.status !== 200) return started;
      id = started.body.id as string;
      pendingBytes.set(id, this.file.buffer);
    }
    return supertest(this.app).post(`${this.url}/${id}/complete`).set(this.headers).type('form').send(this.fields);
  }

  /**
   * Runs the upload, so the builder can be awaited like a supertest request.
   * @param onFulfilled - Called with the response.
   * @param onRejected - Called with a failure.
   * @returns The chained promise.
   */
  then<R1 = SupertestResponse, R2 = never>(
    onFulfilled?: ((value: SupertestResponse) => R1 | PromiseLike<R1>) | null,
    onRejected?: ((reason: unknown) => R2 | PromiseLike<R2>) | null,
  ): PromiseLike<R1 | R2> {
    return this.run().then(onFulfilled, onRejected);
  }
}

/**
 * Starts an upload request against `app`, in the style of `supertest(app)`.
 * @param app - The Express app (or server) under test.
 * @returns An object whose `post(url)` begins an {@link UploadRequest} to that upload path.
 */
export function uploadRequest(app: Parameters<typeof supertest>[0]): { post(url: string): UploadRequest } {
  return { post: (url: string) => new UploadRequest(app, url) };
}
