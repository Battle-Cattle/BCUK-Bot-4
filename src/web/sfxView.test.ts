import { describe, it, expect } from 'vitest';
import path from 'path';
import ejs from 'ejs';

const viewPath = path.join(__dirname, '../../views/sfx.ejs');

/**
 * Renders the SFX page with a manager signed in and two categories.
 * @returns the rendered HTML
 */
function render(): Promise<string> {
  return ejs.renderFile(viewPath, {
    user: { discordId: '1', discordName: 'Manager', accessLevel: 3, isOwner: false, currentGuildId: null, guilds: [] },
    csrfToken: 'tok',
    triggers: [],
    categories: [{ id: 1, name: 'Reactions' }, { id: 2, name: 'Memes' }],
    canManage: true,
    canSuggestDescriptions: true,
    maxUploadMb: 5,
    error: null,
    success: null,
  });
}

describe('views/sfx.ejs', () => {
  it('fits the categories table to the phone width so Rename and Remove stay on screen', async () => {
    const html = await render();
    expect(html).toMatch(/<div class="table-scroll">\s*<table class="table table-fit" aria-label="SFX categories">/);
    expect(html.match(/>Remove</g)).toHaveLength(2);
    expect(html.match(/>Rename</g)).toHaveLength(2);
  });
});
