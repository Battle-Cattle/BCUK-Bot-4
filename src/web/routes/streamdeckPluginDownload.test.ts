import { describe, it, expect } from 'vitest';
import supertest from 'supertest';
import express from 'express';
import router, { STREAMDECK_PLUGIN_DOWNLOAD_URL, STREAMDECK_PLUGIN_FILE } from './streamdeckPluginDownload';

describe('GET /downloads/<plugin file>', () => {
  it('redirects to the latest GitHub release asset', async () => {
    const app = express();
    app.use(router);
    const res = await supertest(app).get(`/downloads/${STREAMDECK_PLUGIN_FILE}`);
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe(STREAMDECK_PLUGIN_DOWNLOAD_URL);
    expect(STREAMDECK_PLUGIN_DOWNLOAD_URL).toBe(
      'https://github.com/Battle-Cattle/BCUK-StreamDeck-Plugin/releases/latest/download/com.expiredminotaur.bcuk.streamDeckPlugin',
    );
  });

  it('takes precedence over a stale copy served by the static middleware mounted after it', async () => {
    const app = express();
    app.use(router);
    app.use((_req, res) => { res.status(200).send('stale file'); });
    const res = await supertest(app).get(`/downloads/${STREAMDECK_PLUGIN_FILE}`);
    expect(res.status).toBe(302);
  });

  it('leaves other downloads alone', async () => {
    const app = express();
    app.use(router);
    app.use((_req, res) => { res.status(204).end(); });
    const res = await supertest(app).get('/downloads/other.zip');
    expect(res.status).toBe(204);
  });
});
