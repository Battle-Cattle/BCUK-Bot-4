import { describe, it, expect } from 'vitest';
import { denyApiKey, getGuildStatusForKey, requestGuildAccessForExistingKey } from './streamdeckKeys';
import { AccessLevel } from './users';
import { insertRow } from '../test-utils/realDbRows';

// requestGuildAccessForExistingKey's upsert against a real MySQL (npm run test:db): a request
// inserts the (key, guild) row, a repeat updates it, and a denied row keeps every column as it was.

async function keyAndGuild(): Promise<{ discordId: string; guildId: string }> {
  const discordId = String((await insertRow('user')).discord_id);
  await insertRow('streamdeck_api_keys', { discord_id: discordId });
  return { discordId, guildId: String((await insertRow('guild')).guild_id) };
}

describe('requestGuildAccessForExistingKey (real MySQL)', () => {
  it('inserts a pending request, then updates it when a manager asks again', async () => {
    const { discordId, guildId } = await keyAndGuild();

    expect(await requestGuildAccessForExistingKey(discordId, AccessLevel.USER, guildId)).toEqual({ status: 'pending' });
    expect(await getGuildStatusForKey(discordId, guildId)).toMatchObject({ status: 'pending', approved_by: null });

    expect(await requestGuildAccessForExistingKey(discordId, AccessLevel.MANAGER, guildId)).toEqual({ status: 'approved' });
    expect(await getGuildStatusForKey(discordId, guildId)).toMatchObject({ status: 'approved', approved_by: discordId });
  });

  it('leaves a denied request untouched and refuses the new one', async () => {
    const { discordId, guildId } = await keyAndGuild();
    await requestGuildAccessForExistingKey(discordId, AccessLevel.USER, guildId);
    await denyApiKey(discordId, guildId);
    const denied = await getGuildStatusForKey(discordId, guildId);

    await expect(requestGuildAccessForExistingKey(discordId, AccessLevel.MANAGER, guildId)).rejects.toThrow('previous request was denied');
    expect(await getGuildStatusForKey(discordId, guildId)).toEqual(denied);
  });
});
