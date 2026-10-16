import { describe, it, expect, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import vm from 'vm';
import ejs from 'ejs';

const viewPath = path.join(__dirname, '../../views/advancedCommands.ejs');
const utilsPath = path.join(__dirname, '../../public/utils.js');
const scriptPath = path.join(__dirname, '../../public/advancedCommands.js');

const COMMAND = {
  id: 7, streamerId: 3, name: 'Hydrate', triggerString: '!hydrate', isEnabled: true, response: 'Drink {user}',
  pointCost: 100, priceStep: 10, maxCost: 200, globalCooldownSeconds: 30, userCooldownSeconds: 60, minRole: 'vip',
  liveOnly: true, maxUsesPerStream: 5, maxUsesPerUserPerStream: null, companionEnabled: true,
  params: [{ key: 'color', value: 'red' }],
  videos: [{ videoId: 2, weight: 3, name: 'Splash', filename: 'v.mp4' }],
  alert: { messageTemplate: '{user} hydrated', imageFilename: 'i.png', soundFilename: null, durationMs: 2500, textAnimation: 'wave' },
};

function render(locals: Record<string, unknown> = {}): Promise<string> {
  return ejs.renderFile(viewPath, {
    user: { discordId: '1', discordName: 'Streamer', accessLevel: 0, isOwner: false, currentGuildId: null, guilds: [] },
    csrfToken: 'tok',
    isStreamer: true,
    streamerId: 3,
    twitchLinked: true,
    chatBotEnabled: true,
    loyaltyPointsEnabled: true,
    commands: [COMMAND],
    videos: [{ id: 2, name: 'Splash' }, { id: 4, name: 'Confetti' }],
    usage: [
      { eventId: 'e1', commandName: 'Hydrate', source: 'chat', twitchUsername: 'alice', pointsSpent: 100, status: 'refunded',
        refundReason: 'companion_error', errorMessage: 'lamp offline', triggeredAt: new Date('2026-10-15T18:30:00Z') },
      { eventId: 'e2', commandName: 'Hydrate', source: 'streamdeck', twitchUsername: null, pointsSpent: 0, status: 'no_ack_needed',
        refundReason: null, errorMessage: null, triggeredAt: new Date('2026-10-15T18:31:00Z') },
    ],
    roles: ['everyone', 'subscriber', 'vip', 'moderator'],
    textAnimations: ['none', 'wave'],
    maxParams: 10,
    maxImageMb: 10,
    maxSoundMb: 5,
    error: null,
    success: null,
    ...locals,
  });
}

describe('views/advancedCommands.ejs', () => {
  it('renders each command\'s settings, effects and actions', async () => {
    const html = await render();
    expect(html).toContain('action="/advanced-commands/add"');
    expect(html).toContain('action="/advanced-commands/7/update"');
    expect(html).toContain('action="/advanced-commands/7/effects"');
    expect(html).toContain('action="/advanced-commands/7/toggle"');
    expect(html).toContain('action="/advanced-commands/7/test"');
    expect(html).toContain('action="/advanced-commands/7/remove"');
    expect(html).toMatch(/<option value="vip" selected>VIPs\+<\/option>/);
    expect(html).toContain('color=red</textarea>');
    expect(html).toMatch(/name="video_2" checked/);
    expect(html).not.toMatch(/name="video_4" checked/);
    expect(html).toContain('name="weight_2" value="3"');
    expect(html).toContain('value="2.5"');
    expect(html).toContain('action="/advanced-commands/7/alert/image"');
    expect(html).toContain('action="/advanced-commands/7/alert/image/delete"');
    expect(html).not.toContain('action="/advanced-commands/7/alert/sound/delete"');
  });

  it('shows the usage log with refund reasons', async () => {
    const html = await render();
    expect(html).toContain('2026-10-15 18:30 UTC');
    expect(html).toContain('(companion error: lamp offline)');
    expect(html).toContain('Stream Deck');
  });

  it('warns when a paid command can\'t be used because loyalty points are off', async () => {
    expect(await render({ loyaltyPointsEnabled: false })).toContain('Loyalty Points is off');
    expect(await render()).not.toContain('Loyalty Points is off');
  });

  it('hides alert uploads until the command has an alert', async () => {
    const html = await render({ commands: [{ ...COMMAND, alert: null }] });
    expect(html).not.toContain('/alert/image"');
  });

  it('shows the non-streamer explanation, errors and successes', async () => {
    const html = await render({ isStreamer: false, error: 'trigger_taken', success: 'added' });
    expect(html).toContain('set up as a monitored streamer');
    expect(html).not.toContain('action="/advanced-commands/add"');
    expect(html).toContain('already used by a custom command');
    expect(html).toContain('Command added.');
  });

  it('escapes command names', async () => {
    const html = await render({ commands: [{ ...COMMAND, name: '<script>x</script>' }] });
    expect(html).not.toContain('<script>x</script>');
  });
});

describe('public/advancedCommands.js', () => {
  it('confirms before deleting a command', () => {
    class TestForm {
      classList = { contains: (name: string) => name === 'js-confirm-delete-command' };
      dataset = { commandName: 'Hydrate' };
    }
    const handlers: Array<(event: unknown) => void> = [];
    const confirm = vi.fn(() => false);
    const context = {
      HTMLFormElement: TestForm,
      window: { confirm },
      document: { addEventListener: (type: string, listener: (event: unknown) => void) => { if (type === 'submit') handlers.push(listener); } },
    };
    vm.runInNewContext(fs.readFileSync(utilsPath, 'utf8'), context);
    vm.runInNewContext(fs.readFileSync(scriptPath, 'utf8'), context);
    const event = { target: new TestForm(), preventDefault: vi.fn() };
    handlers.forEach((h) => h(event));
    expect(confirm).toHaveBeenCalledWith('Delete Hydrate? Its usage history is kept.');
    expect(event.preventDefault).toHaveBeenCalled();
  });
});
