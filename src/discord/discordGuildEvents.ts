// The bot joining and leaving Discord servers: records a newly-seen guild, provisions its owner
// only when it is on DISCORD_AUTO_PROVISION_GUILD_IDS, and forgets a departed guild's in-memory
// state. Registered on each new client by `discordBot.ts`, which owns the client itself.
import type { Client, Guild } from 'discord.js';
import { DISCORD_AUTO_PROVISION_GUILD_IDS } from '../shared/config';
import { forgetGuildCommandState } from '../commands/commandRouter';
import { forgetGuildCustomCommandCooldown } from '../commands/customCommandHandler';
import { forgetGuildCounterCooldown } from '../commands/counterHandler';
import { clearVoiceStatus } from '../shared/statusStore';
import { forgetGuild as forgetGuildVoiceState } from '../audio/audioPlayer';
import { forgetGuildRefreshState } from './guildRefreshState';
import { sendOwnerAlert } from './ownerAlerts';
import { reloadGuildRegistry } from './guildRegistry';
import { upsertGuild, getGuildById, findUser, upsertUser, setMemberAccessLevel, AccessLevel } from '../db';
import { runUserMutation } from '../shared/userMutationQueue';
import { createLogger } from '../shared/logger';

const log = createLogger('Discord');

/**
 * Grants the Discord server's owner Admin access to a brand-new guild, creating
 * their whitelist `user` row first if they don't already have one. Only ever
 * called for an allowlisted guild's first-ever appearance (see
 * {@link handleFirstGuildJoin}) — never on a reconnect — so a deliberately
 * de-provisioned guild is never silently re-granted. Never overwrites an
 * existing user's identity/legacy fields.
 *
 * Only a failure to fetch the guild owner from Discord is swallowed here (logged,
 * then returns) — that's the one step expected to fail transiently. DB failures
 * while granting access are allowed to propagate to the caller, since by that
 * point the guild row already exists and the next `guildCreate` will treat this
 * guild as pre-existing and skip provisioning; surfacing the error as a guild
 * registration failure (rather than swallowing it silently) makes that case
 * visible instead of leaving the guild inert with no record of why.
 *
 * @param guild - The discord.js Guild that was just joined for the first time.
 * @returns Resolves once the owner's access is granted, or once an owner-fetch
 *   failure has been logged. Rejects if granting DB access fails.
 *
 * The user-row read/upsert/access-grant sequence is serialised through {@link runUserMutation}
 * on `owner.id`, matching every other write path that touches a user row by `discord_id` (e.g.
 * the webpanel's admin routes) — a user can belong to multiple guilds, so an unqueued sequence
 * here could otherwise race against a concurrent webpanel edit of the same user.
 */
async function provisionGuildOwner(guild: Guild): Promise<void> {
  let owner;
  try {
    owner = await guild.fetchOwner();
  } catch (err) {
    log.error(`Failed to fetch owner for guild ${guild.id}:`, err);
    return;
  }
  await runUserMutation(owner.id, async () => {
    const existingUser = await findUser(owner.id);
    if (!existingUser) {
      await upsertUser(owner.id, owner.user.username);
    }
    await setMemberAccessLevel(guild.id, owner.id, AccessLevel.ADMIN);
  });
  log.info(`Granted Admin access to server owner ${owner.user.tag} (${owner.id}) for guild '${guild.name}' (${guild.id}).`);
}

/**
 * Handles the bot's first-ever appearance in a guild. A guild on
 * `DISCORD_AUTO_PROVISION_GUILD_IDS` gets its Discord owner granted Admin access
 * ({@link provisionGuildOwner}). Any other guild is left inert: no member is
 * added, so it isn't served and nobody can sign in to it, and the bot owner is
 * alerted so they can add its first member on the panel's Users page if the
 * server is wanted. Without this gate, anyone able to invite the bot would
 * become a panel Admin with reach into the catalogs every guild shares.
 * @param guild - The discord.js Guild that was just joined for the first time.
 * @returns Resolves once the owner is provisioned, or straight away for a guild left inert.
 */
async function handleFirstGuildJoin(guild: Guild): Promise<void> {
  if (DISCORD_AUTO_PROVISION_GUILD_IDS.has(guild.id)) {
    await provisionGuildOwner(guild);
    return;
  }
  log.warn(`Joined guild '${guild.name}' (${guild.id}), which is not on DISCORD_AUTO_PROVISION_GUILD_IDS; leaving it unprovisioned.`);
  // Not awaited: sendOwnerAlert waits for Discord to be ready and never throws, and the
  // registry reload after this shouldn't wait on a DM.
  void sendOwnerAlert(
    `🟡 The bot was added to the Discord server '${guild.name}' (${guild.id}). It isn't on DISCORD_AUTO_PROVISION_GUILD_IDS, `
      + 'so nobody was given access and the bot ignores it. If you want it served, add its first member on the panel\'s Users page.',
  );
}

/**
 * Bootstrap: when the bot is added to a server for the first time, record the
 * guild row and hand it to {@link handleFirstGuildJoin}, which provisions the
 * server's owner only for an allowlisted guild. guildCreate also fires on
 * reconnect, and `guild` rows are never deleted on leave, so that runs only the
 * first time a guild_id is ever seen (detected via getGuildById returning null
 * beforehand) — never on a reconnect or a kick-then-reinvite. This preserves
 * the invariant that a deliberately de-provisioned guild (all members removed)
 * stays inert until someone manually re-provisions it; upsertGuild itself is
 * insert-if-not-exists and never wipes existing per-guild config.
 * @param client - The Discord client to register the handler on.
 */
export function registerGuildCreateHandler(client: Client): void {
  client.on('guildCreate', (guild) => {
    (async () => {
      const isNewGuild = (await getGuildById(guild.id)) === null;
      await upsertGuild(guild.id, guild.name);
      if (isNewGuild) {
        await handleFirstGuildJoin(guild);
      }
      await reloadGuildRegistry();
      log.info(`Registered guild '${guild.name}' (${guild.id}).`);
    })().catch((err: unknown) => log.error(`Failed to register guild ${guild.id}:`, err));
  });
}

/**
 * The bot's per-guild in-memory state (voice connections, command cooldowns,
 * dashboard voice status, admin name-refresh progress) is populated lazily
 * and never expires on its own. Without this, a guild the bot is kicked
 * from — or that deletes itself — leaves its entry behind forever in a
 * long-running process. None of this touches the `guild` DB row, which
 * (like guildCreate) is intentionally never deleted on leave.
 * @param client - The Discord client to register the handler on.
 */
export function registerGuildDeleteHandler(client: Client): void {
  client.on('guildDelete', (guild) => {
    forgetGuildVoiceState(guild.id);
    forgetGuildCommandState(guild.id);
    forgetGuildCustomCommandCooldown(guild.id);
    forgetGuildCounterCooldown(guild.id);
    clearVoiceStatus(guild.id);
    forgetGuildRefreshState(guild.id);
    log.info(`Forgot in-memory state for guild '${guild.name}' (${guild.id}) — bot removed.`);
  });
}
