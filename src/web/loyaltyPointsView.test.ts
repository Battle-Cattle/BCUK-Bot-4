import { describe, it, expect, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import vm from 'vm';
import ejs from 'ejs';

const viewPath = path.join(__dirname, '../../views/loyaltyPoints.ejs');
const utilsPath = path.join(__dirname, '../../public/utils.js');
const scriptPath = path.join(__dirname, '../../public/loyaltyPoints.js');

/** Loads public/utils.js + public/loyaltyPoints.js in a stub DOM and submits an "Exclude bot" form through the registered handler. */
function submitExcludeForm(confirmResult: boolean, formClass = 'js-confirm-exclude-bot') {
  class TestForm {
    classList = { contains: (name: string) => name === formClass };
    dataset = { twitchUsername: 'pokemoncommunitygame' };
  }
  let submitHandler: ((event: unknown) => void) | undefined;
  const confirm = vi.fn(() => confirmResult);
  const context = {
    HTMLFormElement: TestForm,
    window: { confirm },
    document: { addEventListener: (type: string, listener: (event: unknown) => void) => { if (type === 'submit') submitHandler = listener; } },
  };
  vm.runInNewContext(fs.readFileSync(utilsPath, 'utf8'), context);
  vm.runInNewContext(fs.readFileSync(scriptPath, 'utf8'), context);
  const event = { target: new TestForm(), preventDefault: vi.fn() };
  submitHandler!(event);
  return { confirm, event };
}

function render(locals: Record<string, unknown>): Promise<string> {
  return ejs.renderFile(viewPath, {
    user: { discordId: '1', discordName: 'Streamer', accessLevel: 0, isOwner: false, currentGuildId: null, guilds: [] },
    csrfToken: 'tok',
    isStreamer: true,
    prerequisites: { twitchLinked: true, chatBotEnabled: true, isMonitoredStreamer: true },
    allPrerequisitesMet: true,
    leaderboard: [],
    excludedUsers: [],
    config: { enabled: true, pointsPerMessage: 1, cooldownSeconds: 60, pointsPerSub: 100, pointsPerGiftSub: 100 },
    error: null,
    ...locals,
  });
}

describe('views/loyaltyPoints.ejs', () => {
  it('shows an "Exclude bot" button for each leaderboard entry, posting that viewer', async () => {
    const html = await render({ leaderboard: [{ twitchUsername: 'pokemoncommunitygame', balance: 900 }, { twitchUsername: 'viewer1', balance: 50 }] });
    expect(html).toContain('action="/loyalty-points/exclusions"');
    expect(html.match(/>Exclude bot</g)).toHaveLength(2);
    expect(html).toContain('name="twitch_username" value="pokemoncommunitygame"');
    expect(html).toContain('name="twitch_username" value="viewer1"');
  });

  it('asks for confirmation before excluding, naming the account', async () => {
    const html = await render({ leaderboard: [{ twitchUsername: 'pokemoncommunitygame', balance: 900 }] });
    expect(html).toContain('class="js-confirm-exclude-bot" data-twitch-username="pokemoncommunitygame"');
    expect(html).toContain('<script src="/utils.js"></script>');
    expect(html).toContain('<script src="/loyaltyPoints.js"></script>');
  });

  it('confirms before excluding, naming the account, and blocks the submit on Cancel', () => {
    const declined = submitExcludeForm(false);
    expect(declined.confirm).toHaveBeenCalledWith(
      'Exclude pokemoncommunitygame as a bot? It will stop earning points and be hidden from the leaderboard.',
    );
    expect(declined.event.preventDefault).toHaveBeenCalledOnce();

    const accepted = submitExcludeForm(true);
    expect(accepted.event.preventDefault).not.toHaveBeenCalled();
  });

  it('does not prompt for other forms on the page', () => {
    const other = submitExcludeForm(false, 'some-other-form');
    expect(other.confirm).not.toHaveBeenCalled();
    expect(other.event.preventDefault).not.toHaveBeenCalled();
  });

  it('lists excluded bots with a "Remove exclusion" button', async () => {
    const html = await render({ excludedUsers: ['bcuk_bot'] });
    expect(html).toContain('action="/loyalty-points/exclusions/remove"');
    expect(html).toContain('name="twitch_username" value="bcuk_bot"');
    expect(html).toContain('Remove exclusion');
    expect(html).not.toContain('No bots are excluded.');
  });

  it('says so when no bots are excluded', async () => {
    const html = await render({});
    expect(html).toContain('No bots are excluded.');
    expect(html).not.toContain('action="/loyalty-points/exclusions/remove"');
  });

  it('shows a readable message for the exclusion error codes', async () => {
    expect(await render({ error: 'invalid_username' })).toContain('That isn&#39;t a valid Twitch username.');
    expect(await render({ error: 'exclusion_failed' })).toContain('Failed to update the excluded bots');
  });

  it('hides the excluded bots card from a signed-in user with no streamer record', async () => {
    const html = await render({ isStreamer: false });
    expect(html).not.toContain('Excluded Bots');
  });
});
