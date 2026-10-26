import { describe, it, expect } from 'vitest';
import path from 'path';
import ejs from 'ejs';

const viewPath = path.join(__dirname, '../../views/health.ejs');

function render(locals: Record<string, unknown> = {}): Promise<string> {
  return ejs.renderFile(viewPath, {
    user: { discordId: '1', discordName: 'Owner', accessLevel: 3, isOwner: true, currentGuildId: null, guilds: [] },
    csrfToken: 'tok',
    health: { errors: [] },
    debugLoggingUntil: null,
    debugLoggingHourOptions: [1, 6, 24, 72],
    defaultDebugLoggingHours: 24,
    success: undefined,
    error: undefined,
    ...locals,
  });
}

describe('views/health.ejs debug logging card', () => {
  it('shows debug logging as off, with the duration choices and 24 hours preselected', async () => {
    const html = await render();

    expect(html).toContain('Off. Turn it on');
    expect(html).toContain('<option value="24" selected>24 hours</option>');
    expect(html).toContain('<option value="1">1 hour</option>');
    expect(html).not.toContain('Turn off now');
    expect(html).toMatch(/<button type="submit" class="btn btn-sm">Turn on<\/button>/);
  });

  it('shows when debug logging switches off, with a button to turn it off now', async () => {
    const html = await render({ debugLoggingUntil: new Date('2026-10-27T12:30:00Z') });

    expect(html).toContain('On until <strong>2026-10-27 12:30 UTC</strong>');
    expect(html).toContain('Turn off now');
    expect(html).toContain('Restart timer');
  });

  it.each([
    ['debug_on', undefined, 'Debug logging is on.'],
    ['debug_off', undefined, 'Debug logging is off.'],
    [undefined, 'debug_invalid', 'Pick one of the listed durations.'],
    [undefined, 'debug_failed', "Couldn't change debug logging."],
  ])('shows the banner for success=%s error=%s', async (success, error, banner) => {
    expect(await render({ success, error })).toContain(banner);
  });
});
