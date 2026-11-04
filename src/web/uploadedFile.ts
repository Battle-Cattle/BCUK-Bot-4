/**
 * A finished upload as the upload areas' handlers receive it in `req.file`, once the chunked
 * upload routes (`routes/chunkedUploadRoutes.ts`) have assembled it. Overlay videos stay on disk
 * (`path`, with an empty `buffer`); the smaller SFX and alert files are read into `buffer`.
 */
export interface UploadedFile {
  /** Name of the form's file field (e.g. `video`, `sound`, `image`). */
  fieldname: string;
  /** The file's name on the user's computer, as the page declared it. */
  originalname: string;
  /** The MIME type the browser reported (may be empty; never trusted to accept a file). */
  mimetype: string;
  /** Size in bytes. */
  size: number;
  /** The file's bytes, for the in-memory areas; empty for a file kept on disk. */
  buffer: Buffer;
  /** Name of the file on disk, for a file kept on disk; empty otherwise. */
  filename: string;
  /** Absolute path of the file on disk, for a file kept on disk; empty otherwise. */
  path: string;
}
