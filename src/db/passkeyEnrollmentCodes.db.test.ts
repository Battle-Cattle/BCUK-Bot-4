import { describe, it, expect } from 'vitest';
import { savePasskeyEnrollmentCode } from './passkeyEnrollmentCodes';
import { insertRow } from '../test-utils/realDbRows';

// savePasskeyEnrollmentCode's resend cooldown against a real MySQL (npm run test:db): the table is
// keyed by discord_id, so a second code inside the cooldown hits the primary key and is refused.

const HOUR = 3600;

describe('savePasskeyEnrollmentCode (real MySQL)', () => {
  it('refuses a second code while the first is inside the resend cooldown', async () => {
    const discordId = String((await insertRow('user')).discord_id);

    expect(await savePasskeyEnrollmentCode(discordId, 'a'.repeat(64), HOUR, HOUR)).toBe(true);
    expect(await savePasskeyEnrollmentCode(discordId, 'b'.repeat(64), HOUR, HOUR)).toBe(false);
  });

  it('replaces the code once the cooldown has passed', async () => {
    const discordId = String((await insertRow('user')).discord_id);
    await savePasskeyEnrollmentCode(discordId, 'a'.repeat(64), HOUR, HOUR);

    // A zero-second cooldown has always passed: the old code is cleared and the new one stored.
    expect(await savePasskeyEnrollmentCode(discordId, 'b'.repeat(64), HOUR, 0)).toBe(true);
  });

  it('keeps cooldowns per user', async () => {
    await savePasskeyEnrollmentCode(String((await insertRow('user')).discord_id), 'a'.repeat(64), HOUR, HOUR);

    expect(await savePasskeyEnrollmentCode(String((await insertRow('user')).discord_id), 'b'.repeat(64), HOUR, HOUR)).toBe(true);
  });
});
