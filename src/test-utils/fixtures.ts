import { AccessLevel, type AccessLevelValue } from '../db';

/** Shape of the `req.session.user` object used across `src/web/routes/*.test.ts` session stubs. */
export interface SessionUserFixture {
  discordId: string;
  discordName: string;
  discordAvatar: string | null;
  accessLevel: AccessLevelValue;
  currentGuildId?: string;
  isOwner?: boolean;
}

/**
 * Builds a fake session user matching the shape hand-rolled across `src/web/routes/*.test.ts`
 * (`{ discordId, discordName, discordAvatar, accessLevel, ... }`). Pass `overrides` to customize
 * any field, e.g. `makeSessionUser({ accessLevel: AccessLevel.ADMIN, currentGuildId: GUILD_ID })`.
 */
export function makeSessionUser(overrides: Partial<SessionUserFixture> = {}): SessionUserFixture {
  return {
    discordId: '100000000000000001',
    discordName: 'TestUser',
    discordAvatar: null,
    accessLevel: AccessLevel.USER,
    ...overrides,
  };
}

/** Shape of a `guild` table row as returned by `src/db/guilds.ts` (BIGINT columns pre-stringified). */
export interface DbGuildFixture {
  guild_id: string;
  name: string;
  voice_channel_id: string | null;
}

/**
 * Builds a fake `guild` row matching the shape returned by `src/db/guilds.ts` query functions
 * (e.g. `getGuildById`, `getAllGuilds`). Pass `overrides` to customize any field.
 */
export function makeDbGuild(overrides: Partial<DbGuildFixture> = {}): DbGuildFixture {
  return {
    guild_id: '900000000000000001',
    name: 'Test Guild',
    voice_channel_id: null,
    ...overrides,
  };
}
