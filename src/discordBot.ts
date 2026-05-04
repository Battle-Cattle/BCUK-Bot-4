import { Client, GatewayIntentBits, Guild } from 'discord.js';
import { DISCORD_TOKEN, DISCORD_GUILD_ID } from './config';
import { connect } from './audioPlayer';
import { handleCommand } from './commandRouter';
import { executeCustomCommandForDiscord } from './customCommandHandler';
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

  client.once('clientReady', async (c) => {
    console.log(`[Discord] Logged in as ${c.user.tag}`);
    discordClient = c;
    try {
      const guild = await getConfiguredGuild();
      setDiscordReady(c.user.tag, guild.name);
      // Small delay to ensure gateway is fully ready before joining voice
      await new Promise((resolve) => setTimeout(resolve, 2000));
      await connect(c);
    } catch (err) {
      console.error('[Discord] Failed to initialise:', err);
    }
  });

  client.on('messageCreate', (message) => {
    if (message.author.bot) return;
    if (message.guildId !== DISCORD_GUILD_ID) return;

    executeCustomCommandForDiscord(message, message.member?.displayName ?? message.author.username).catch((err) =>
      console.error('[Discord] Custom command error:', err),
    );

    handleCommand(message.content, 'discord').catch((err) =>
      console.error('[Discord] Command handler error:', err),
    );
  });

  client.on('error', (err) => {
    console.error('[Discord] Client error:', err);
  });

  client.login(DISCORD_TOKEN).catch((err) => console.error('[Discord] Login failed:', err));
}
