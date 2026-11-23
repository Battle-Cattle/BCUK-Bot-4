import { describe, it, expect } from 'vitest';
import path from 'path';
import ejs from 'ejs';

// Every guild-scoped mutation form on the Users and Streamdeck key admin pages carries the guild the
// page was rendered for, which requireFormGuild checks against the session (issue #1051).

const VIEWS = path.join(__dirname, '../../views');
const GUILD_ID = '900000000000000001';
const USER = { discordId: '100000000000000001', discordName: 'Admin', accessLevel: 3, isOwner: false, currentGuildId: GUILD_ID, guilds: [] };
const MEMBER = { discord_id: '300000000000000001', discord_name: 'Member', twitch_name: 'chan', is_twitch_bot_enabled: true, access_level: 1 };

/** The `<form>` elements in `html` that post to `action`. */
function formsFor(html: string, action: string): string[] {
  return [...html.matchAll(/<form\b[^>]*>[\s\S]*?<\/form>/g)].map((m) => m[0]).filter((f) => f.includes(`action="${action}"`));
}

describe('views/admin.ejs', () => {
  it.each(['/admin/users/add', '/admin/users/update', '/admin/users/remove', '/admin/users/toggle-twitch'])(
    'the %s form carries the page\'s guild',
    async (action) => {
      const html = await ejs.renderFile(path.join(VIEWS, 'admin.ejs'), {
        user: USER, users: [MEMBER], csrfToken: 'tok', accessLevelLabels: { 0: 'User', 1: 'Mod', 2: 'Manager', 3: 'Admin' },
        error: null, refreshState: { outcome: 'idle' },
      });
      const forms = formsFor(html, action);
      expect(forms).toHaveLength(1);
      expect(forms[0]).toContain(`name="guild_id" value="${GUILD_ID}"`);
    },
  );

  it.each([['guild_changed', 'switched server in another tab'], ['not_found', 'not a member of this server']])(
    'explains ?error=%s',
    async (error, text) => {
      const html = await ejs.renderFile(path.join(VIEWS, 'admin.ejs'), {
        user: USER, users: [], csrfToken: 'tok', accessLevelLabels: {}, error, refreshState: { outcome: 'idle' },
      });
      expect(html).toContain(text);
    },
  );
});

describe('views/streamdeck-keys-admin.ejs', () => {
  const row = (status: string) => ({ discord_id: '300000000000000001', user_name: null, status, requested_at: new Date(), approved_by: null, approver_name: null });

  it.each(['/admin/streamdeck-keys/approve', '/admin/streamdeck-keys/deny', '/admin/streamdeck-keys/revoke'])(
    'every %s form carries the page\'s guild',
    async (action) => {
      const html = await ejs.renderFile(path.join(VIEWS, 'streamdeck-keys-admin.ejs'), {
        user: USER, csrfToken: 'tok', pending: [row('pending')], all: [row('pending'), row('approved')], error: null,
      });
      const forms = formsFor(html, action);
      expect(forms.length).toBeGreaterThan(0);
      for (const form of forms) expect(form).toContain(`name="guild_id" value="${GUILD_ID}"`);
    },
  );

  it('explains ?error=guild_changed', async () => {
    const html = await ejs.renderFile(path.join(VIEWS, 'streamdeck-keys-admin.ejs'), {
      user: USER, csrfToken: 'tok', pending: [], all: [], error: 'guild_changed',
    });
    expect(html).toContain('switched server in another tab');
  });
});
