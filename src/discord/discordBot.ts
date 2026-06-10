import { Client, GatewayIntentBits, Guild } from 'discord.js';
import { DISCORD_TOKEN, DISCORD_GUILD_ID } from '../shared/config';
import { handleCommand } from '../commands/commandRouter';
import { executeCustomCommandForDiscord } from '../commands/customCommandHandler';
import { executeCounterCommandForDiscord } from '../commands/counterHandler';
import { setDiscordReady } from '../shared/statusStore';
import { createLogger } from '../shared/logger';

const log = createLogger('Discord');

let client: Client | null = null;
let bootingClient: Client | null = null;
let cachedGuild: Guild | null = null;

/** Returns the Discord.js Client once it has fired `clientReady`, or null before then. */
export function getDiscordClient(): Client | null { return client; }

async function getConfiguredGuild(): Promise<Guild> {
  if (!client) {
    throw new Error('Discord client is not ready');
  }

  const guildFromCache = client.guilds.cache.get(DISCORD_GUILD_ID);
  if (guildFromCache) {
    cachedGuild = guildFromCache;
    return guildFromCache;
  }

  if (cachedGuild) {
    return cachedGuild;
  }

  cachedGuild = await client.guilds.fetch(DISCORD_GUILD_ID);
  return cachedGuild;
}

/**
 * Fetch the display name of a Discord guild member.
 * Returns null if the client is not ready, the guild is unavailable, or the member is not found.
 *
 * @param discordId - Discord user snowflake ID to look up.
 * @param force - When true, bypasses the guild member cache and fetches fresh from the API.
 * @returns The member's server display name, or null on any failure.
 */
export async function fetchMemberDisplayName(discordId: string, force = false): Promise<string | null> {
  if (!client) return null;
  try {
    const guild = await getConfiguredGuild();
    const member = await guild.members.fetch({ user: discordId, force });
    return member.displayName;
  } catch (err) {
    log.warn(`Failed to fetch display name for ${discordId}:`, err);
    return null;
  }
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
    if (message.guildId !== DISCORD_GUILD_ID) return;

    const displayName = message.member?.displayName ?? message.author.username;

    executeCustomCommandForDiscord(message, displayName).catch((err) =>
      log.error('Custom command error:', err),
    );

    executeCounterCommandForDiscord(message, displayName).catch((err) =>
      log.error('Counter command error:', err),
    );

    handleCommand(message.content, 'discord').catch((err) =>
      log.error('Command handler error:', err),
    );
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
      const guild = await getConfiguredGuild();
      setDiscordReady(c.user.tag, guild.name);
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
  cachedGuild = null;
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
