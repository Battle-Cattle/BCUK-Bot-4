import { describe, it, expect } from 'vitest';
import { insertPasskey, type NewPasskey } from './webauthnCredentials';
import { insertRow } from '../test-utils/realDbRows';

// insertPasskey against a real MySQL (npm run test:db): a credential id already stored (the
// primary key) comes back as 'duplicate', whichever user registers it.

function passkey(discordId: string, credentialId = 'credential-1'): NewPasskey {
  return {
    credentialId, discordId, userHandle: `handle-${discordId}`, publicKey: new Uint8Array([1, 2, 3]),
    signCount: 0, transports: ['internal'], deviceLabel: 'Laptop',
  };
}

async function newUserId(): Promise<string> {
  return String((await insertRow('user')).discord_id);
}

describe('insertPasskey (real MySQL)', () => {
  it("reports a credential id that's already registered as a duplicate", async () => {
    const discordId = await newUserId();
    expect(await insertPasskey(passkey(discordId), 10)).toBe('inserted');

    expect(await insertPasskey(passkey(discordId), 10)).toBe('duplicate');
    expect(await insertPasskey(passkey(await newUserId()), 10)).toBe('duplicate');
  });

  it('stores different credential ids up to the per-user limit', async () => {
    const discordId = await newUserId();
    expect(await insertPasskey(passkey(discordId, 'credential-1'), 2)).toBe('inserted');
    expect(await insertPasskey(passkey(discordId, 'credential-2'), 2)).toBe('inserted');

    expect(await insertPasskey(passkey(discordId, 'credential-3'), 2)).toBe('limit');
  });
});
