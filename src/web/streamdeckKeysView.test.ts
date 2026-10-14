import { describe, it, expect, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import vm from 'vm';
import ejs from 'ejs';

const viewPath = path.join(__dirname, '../../views/streamdeck-keys.ejs');
const scriptPath = path.join(__dirname, '../../public/streamdeck-keys.js');

function render(): Promise<string> {
  return ejs.renderFile(viewPath, {
    user: { discordId: '111111111111111111', discordName: 'Streamer', accessLevel: 0, isOwner: false, currentGuildId: '900000000000000001', guilds: [] },
    csrfToken: 'tok',
    keyRow: null,
    newKey: null,
    error: null,
  });
}

/** Runs public/streamdeck-keys.js against the rendered page's element ids and returns them. */
function runPageScript(html: string, origin: string): Map<string, { textContent: string }> {
  const elements = new Map<string, { textContent: string }>();
  for (const [, id] of html.matchAll(/\sid="([^"]+)"/g)) elements.set(id!, { textContent: '' });
  const context = {
    window: { location: { origin } },
    document: {
      getElementById: (id: string) => elements.get(id) ?? null,
      addEventListener: vi.fn(),
    },
    confirmSubmit: vi.fn(),
    registerCopyToClipboardHandler: vi.fn(),
  };
  vm.runInNewContext(fs.readFileSync(scriptPath, 'utf8'), context);
  return elements;
}

describe('views/streamdeck-keys.ejs + public/streamdeck-keys.js', () => {
  it('fills the Server URL cell with the origin the panel is served from', async () => {
    const elements = runPageScript(await render(), 'https://bot.example.com');
    expect(elements.get('sd-server-url-cell')?.textContent).toBe('https://bot.example.com');
  });

  it('links the Download Plugin button to the redirecting download route', async () => {
    const html = await render();
    expect(html).toContain('href="/downloads/com.expiredminotaur.bcuk.streamDeckPlugin"');
  });
});
