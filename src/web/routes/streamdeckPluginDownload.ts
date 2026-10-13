import { Router } from 'express';

const router = Router();

/** File name of the packed Stream Deck plugin, as published on each plugin release. */
export const STREAMDECK_PLUGIN_FILE = 'com.expiredminotaur.bcuk.streamDeckPlugin';

/**
 * The plugin's newest release asset. The plugin repo's CI publishes a GitHub Release whenever
 * its manifest version changes, and `releases/latest/download/<file>` always resolves to the
 * newest one, so the panel never needs a copy of the file on the server.
 */
export const STREAMDECK_PLUGIN_DOWNLOAD_URL =
  `https://github.com/Battle-Cattle/BCUK-StreamDeck-Plugin/releases/latest/download/${STREAMDECK_PLUGIN_FILE}`;

/**
 * GET /downloads/com.expiredminotaur.bcuk.streamDeckPlugin — redirects to the latest plugin
 * release. Keeps the panel's long-standing download URL working now that the file is no longer
 * copied into `public/downloads/` by hand. Mounted ahead of the static middleware so a stale
 * copy left in that folder can't shadow it. Public, like the static file it replaces.
 * @param _req - Express request (unused).
 * @param res - Express response; sent a 302 to the latest release asset.
 */
router.get(`/downloads/${STREAMDECK_PLUGIN_FILE}`, (_req, res) => {
  res.redirect(302, STREAMDECK_PLUGIN_DOWNLOAD_URL);
});

export default router;
