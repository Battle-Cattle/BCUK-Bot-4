import { Client, GatewayIntentBits, Guild } from 'discord.js';
import { DISCORD_TOKEN, DISCORD_GUILD_ID } from '../shared/config';
import { handleCommand } from '../commands/commandRouter';
import { executeCustomCommandForDiscord } from '../commands/customCommandHandler';
import { executeCounterCommandForDiscord } from '../commands/counterHandler';
import { setDiscordReady } from '../shared/statusStore';
import { createLogger } from '../shared/logger';

const log = createLogger('Discord');

let client: Client | null = null;
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

export function startDiscordBot(): void {
  client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
      GatewayIntentBits.GuildVoiceStates,
    ],
  });

  client.on('messageCreate', (message) => {
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

  client.once('clientReady', async (c) => {
    log.info(`Logged in as ${c.user.tag}`);
    client = c;
    try {
      const guild = await getConfiguredGuild();
      setDiscordReady(c.user.tag, guild.name);
    } catch (err) {
      log.error('Failed to initialise:', err);
    }
  });

  client.on('error', (err) => {
    log.error('Client error:', err);
  });

  client.login(DISCORD_TOKEN).catch((err) => log.error('Login failed:', err));
}

export function stopDiscordBot(): void {
  const existing = client;
  client = null;
  cachedGuild = null;
  try {
    existing?.destroy();
  } catch (err) {
    log.error('Error destroying client:', err);
  }
  log.info('Client destroyed.');
}
