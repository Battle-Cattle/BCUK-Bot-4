import { Client, GatewayIntentBits, Guild } from 'discord.js';
import { DISCORD_TOKEN } from '../shared/config';
import { handleCommand } from '../commands/commandRouter';
import { executeCustomCommandForDiscord } from '../commands/customCommandHandler';
import { executeCounterCommandForDiscord } from '../commands/counterHandler';
import { setDiscordReady } from '../shared/statusStore';
import { isRegisteredGuild, reloadGuildRegistry } from './guildRegistry';
import { upsertGuild, getAllGuilds, getGuildById, findUser, upsertUser, setMemberAccessLevel, AccessLevel } from '../db';
import { createLogger } from '../shared/logger';

const log = createLogger('Discord');

let client: Client | null = null;
let bootingClient: Client | null = null;

/** Returns the Discord.js Client once it has fired `clientReady`, or null before then. */
export function getDiscordClient(): Client | null { return client; }

/**
 * Resolve a guild by ID from the discord.js cache, falling back to a fetch.
 * @throws if the client is not ready.
 */
async function getGuild(guildId: string): Promise<Guild> {
  if (!client) {
    throw new Error('Discord client is not ready');
  }
  const cached = client.guilds.cache.get(guildId);
  if (cached) return cached;
  return client.guilds.fetch(guildId);
}

/**
 * Fetch the display name of a Discord guild member.
 * Returns null if the client is not ready, the guild is unavailable, or the member is not found.
 *
 * @param discordId - Discord user snowflake ID to look up.
 * @param guildId - Guild to look the member up in.
 * @param force - When true, bypasses the guild member cache and fetches fresh from the API.
 * @returns The member's server display name, or null on any failure.
 */
export async function fetchMemberDisplayName(
  discordId: string,
  guildId: string,
  force = false,
): Promise<string | null> {
  if (!client) return null;
  try {
    const guild = await getGuild(guildId);
    const member = await guild.members.fetch({ user: discordId, force });
    return member.displayName;
  } catch (err) {
    log.warn(`Failed to fetch display name for ${discordId}:`, err);
    return null;
  }
}

/**
 * Grants the Discord server's owner Admin access to a brand-new guild, creating
 * their whitelist `user` row first if they don't already have one. Only ever
 * called for a guild's first-ever appearance (see the `guildCreate` handler in
 * {@link startDiscordBot}) — never on a reconnect — so a deliberately
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
 */
async function provisionGuildOwner(guild: Guild): Promise<void> {
  let owner;
  try {
    owner = await guild.fetchOwner();
  } catch (err) {
    log.error(`Failed to fetch owner for guild ${guild.id}:`, err);
    return;
  }
  const existingUser = await findUser(owner.id);
  if (!existingUser) {
    await upsertUser(owner.id, owner.user.username, AccessLevel.USER);
  }
  await setMemberAccessLevel(guild.id, owner.id, AccessLevel.ADMIN);
  log.info(`Granted Admin access to server owner ${owner.user.tag} (${owner.id}) for guild '${guild.name}' (${guild.id}).`);
}

/**
 * Create and connect a Discord client. No-op if a client is already running or
 * booting — call {@link stopDiscordBot} first to replace it.
 *
 * The module-level client (returned by {@link getDiscordClient}) is set only
 * once `clientReady` fires, so callers cannot observe a partially-initialised
 * client. If {@link stopDiscordBot} is called before the connection completes,
 * the in-flight client is destroyed and the `clientReady` handler is discarded.
 * If login fails, `bootingClient` is cleared so the next call can retry.
 *
 * The guild registry must be loaded (see {@link reloadGuildRegistry}) before the
 * client connects, so the `messageCreate` gate can recognise registered guilds.
 */
export function startDiscordBot(): void {
  if (client || bootingClient) return;
  const localClient = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
      GatewayIntentBits.GuildVoiceStates,
    ],
  });
  bootingClient = localClient;

  localClient.on('messageCreate', (message) => {
    if (message.author.bot) return;
    if (!message.guildId || !isRegisteredGuild(message.guildId)) return;

    const displayName = message.member?.displayName ?? message.author.username;
    const guildId = message.guildId;

    executeCustomCommandForDiscord(message, displayName, guildId).catch((err) =>
      log.error('Custom command error:', err),
    );

    executeCounterCommandForDiscord(message, displayName).catch((err) =>
      log.error('Counter command error:', err),
    );

    handleCommand(message.content, 'discord', guildId).catch((err) =>
      log.error('Command handler error:', err),
    );
  });

  // Bootstrap: when the bot is added to a server for the first time, record the
  // guild row and auto-grant the Discord server's owner Admin access to it, so
  // they can self-serve the panel without the bot owner manually provisioning the
  // first member. guildCreate also fires on reconnect, and `guild` rows are never
  // deleted on leave, so the owner grant runs only the first time a guild_id is
  // ever seen (detected via getGuildById returning null beforehand) — never on a
  // reconnect or a kick-then-reinvite. This preserves the existing invariant that
  // a deliberately de-provisioned guild (all members removed) stays inert until
  // someone manually re-provisions it; upsertGuild itself is insert-if-not-exists
  // and never wipes existing per-guild config.
  localClient.on('guildCreate', (guild) => {
    (async () => {
      const isNewGuild = (await getGuildById(guild.id)) === null;
      await upsertGuild(guild.id, guild.name);
      if (isNewGuild) {
        await provisionGuildOwner(guild);
      }
      await reloadGuildRegistry();
      log.info(`Registered guild '${guild.name}' (${guild.id}).`);
    })().catch((err) => log.error(`Failed to register guild ${guild.id}:`, err));
  });

  localClient.once('clientReady', async (c) => {
    if (bootingClient !== localClient) {
      // stopDiscordBot() ran during boot — discard this ready client
      try { c.destroy(); } catch { /* ignore */ }
      return;
    }
    bootingClient = null;
    client = c;
    log.info(`Logged in as ${c.user.tag}`);
    try {
      const registeredGuilds = await getAllGuilds();
      const names = registeredGuilds.map((g) => g.name).join(', ') || 'Unknown';
      setDiscordReady(c.user.tag, names);
    } catch (err) {
      log.error('Failed to initialise:', err);
    }
  });

  localClient.on('error', (err) => {
    log.error('Client error:', err);
  });

  localClient.login(DISCORD_TOKEN).catch((err) => {
    log.error('Login failed:', err);
    bootingClient = null; // clear so the next startDiscordBot() call can retry
  });
}

/**
 * Disconnect and destroy the Discord client, including any client that is
 * still connecting. Idempotent — safe to call before {@link startDiscordBot}.
 * Errors thrown by `destroy()` are caught and logged rather than propagated.
 */
export function stopDiscordBot(): void {
  const existingReady = client;
  const existingBooting = bootingClient;
  client = null;
  bootingClient = null;
  try {
    existingReady?.destroy();
  } catch (err) {
    log.error('Error destroying client:', err);
  }
  try {
    existingBooting?.destroy();
  } catch (err) {
    log.error('Error destroying booting client:', err);
  }
  log.info('Client destroyed.');
}
