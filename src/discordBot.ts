import { Client, GatewayIntentBits, Guild } from 'discord.js';
import { DISCORD_TOKEN, DISCORD_GUILD_ID } from './config';
import { handleCommand } from './commandRouter';
import { executeCustomCommandForDiscord } from './customCommandHandler';
import { executeCounterCommandForDiscord } from './counterHandler';
import { setDiscordReady } from './statusStore';

let client: Client;
let cachedGuild: Guild | null = null;

/** The Discord.js Client instance once it has fired `clientReady`, or null before then. */
export let discordClient: Client | null = null;

async function getConfiguredGuild(): Promise<Guild> {
  if (!discordClient) {
    throw new Error('Discord client is not ready');
  }

  const guildFromCache = discordClient.guilds.cache.get(DISCORD_GUILD_ID);
  if (guildFromCache) {
    cachedGuild = guildFromCache;
    return guildFromCache;
  }

  if (cachedGuild) {
    return cachedGuild;
  }

  cachedGuild = await discordClient.guilds.fetch(DISCORD_GUILD_ID);
  return cachedGuild;
}

export async function fetchMemberDisplayName(discordId: string, force = false): Promise<string | null> {
  if (!discordClient) return null;
  try {
    const guild = await getConfiguredGuild();
    const member = await guild.members.fetch({ user: discordId, force });
    return member.displayName;
  } catch (err) {
    console.warn(`[Discord] Failed to fetch display name for ${discordId}:`, err);
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
      console.error('[Discord] Custom command error:', err),
    );

    executeCounterCommandForDiscord(message, displayName).catch((err) =>
      console.error('[Discord] Counter command error:', err),
    );

    handleCommand(message.content, 'discord').catch((err) =>
      console.error('[Discord] Command handler error:', err),
    );
  });

  client.once('clientReady', async (c) => {
    try {
      console.log(`[Discord] Logged in as ${c.user.tag}`);
      discordClient = c;
      try {
        const guild = await getConfiguredGuild();
        setDiscordReady(c.user.tag, guild.name);
      } catch (err) {
        console.error('[Discord] Failed to initialise:', err);
      }
    } catch (err) {
      console.error('[Discord] Unexpected error in clientReady handler:', err);
    }
  });

  client.on('error', (err) => {
    console.error('[Discord] Client error:', err);
  });

  client.login(DISCORD_TOKEN).catch((err) => console.error('[Discord] Login failed:', err));
}
