import { describe, it, expect } from 'vitest';
import { addStreamGroup, type AddStreamGroupInput } from './streamMonitor';
import { insertRow } from '../test-utils/realDbRows';

// addStreamGroup against a real MySQL (npm run test:db): its INSERT … WHERE NOT EXISTS skips a
// name the guild already uses, and only within that guild.

async function group(name: string): Promise<AddStreamGroupInput> {
  const guildId = String((await insertRow('guild')).guild_id);
  return {
    guildId, name, discordChannel: '900000000000000003', liveMessage: 'live', newGameMessage: 'new game',
    multiTwitch: false, deleteOldPosts: false,
  };
}

describe('addStreamGroup (real MySQL)', () => {
  it("returns false for a name the guild already has, and true for the same name in another guild", async () => {
    const first = await group('Main');
    expect(await addStreamGroup(first)).toBe(true);

    expect(await addStreamGroup(first)).toBe(false);
    expect(await addStreamGroup(await group('Main'))).toBe(true);
  });
});
