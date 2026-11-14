import type { Request, Response } from 'express';
import { discardUpload } from './overlayUploadStorage';

/** Completes one finished upload (checks, converts, stores) and sends the response. */
type UploadHandler = (req: Request, res: Response) => Promise<void>;

/** A fixed number of slots for processing finished uploads, shared by one upload area's routes. */
export interface UploadSlots {
  /** True while every slot is taken, so a new upload would be turned away with `upload_busy`. */
  isFull(): boolean;
  /**
   * Wraps an upload's completion handler so it runs only inside a slot.
   * @param handler - Completes the upload and sends the response.
   * @returns Express handler that admits or turns away the upload.
   */
  admit(handler: UploadHandler): UploadHandler;
}

/**
 * Creates the slots that bound how many finished uploads are processed at once. A slot is held
 * for as long as the completion handler runs, not as long as the HTTP response is open: a client
 * that leaves the page mid-conversion doesn't free its slot while the server is still converting,
 * so the slot count never drops below the work actually running (#899).
 * @param max - Most uploads processed at once.
 * @param busyRedirect - Where a turned-away upload is redirected (an `?error=upload_busy` URL).
 * @returns The slots for one upload area.
 */
export function createUploadSlots(max: number, busyRedirect: string): UploadSlots {
  let active = 0;
  return {
    /**
     * Reports whether every slot is taken.
     * @returns True when `max` uploads are being processed.
     */
    isFull: () => active >= max,
    /**
     * Wraps a completion handler so it runs inside a slot.
     * @param handler - Completes the upload and sends the response.
     * @returns Express handler: with a free slot, runs `handler` and frees the slot once it has
     *   settled, whichever way; otherwise removes the upload's file and redirects to `busyRedirect`.
     */
    admit: (handler) => async (req, res) => {
      if (active >= max) {
        if (req.file) await discardUpload(req.file);
        res.redirect(busyRedirect);
        return;
      }
      active++;
      try {
        await handler(req, res);
      } finally {
        active--;
      }
    },
  };
}
