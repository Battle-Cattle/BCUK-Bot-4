import { Client, GatewayIntentBits, Guild, Partials } from 'discord.js';
import { DISCORD_TOKEN } from '../shared/config';
import { handleCommand, forgetGuildCommandState } from '../commands/commandRouter';
import { fireAndForget, extractCommand } from '../commands/commandUtils';
import { executeCustomCommandForDiscord, forgetGuildCustomCommandCooldown } from '../commands/customCommandHandler';
import { executeCounterCommandForDiscord, forgetGuildCounterCooldown } from '../commands/counterHandler';
import { setDiscordReady, clearVoiceStatus } from '../shared/statusStore';
import { recordDiscordConnected } from '../shared/healthStore';
import { executeHealthCommandForDiscord } from '../commands/healthCommandHandler';
import { forgetGuild as forgetGuildVoiceState } from '../audio/audioPlayer';
import { forgetGuildRefreshState } from './guildRefreshState';
import { isRegisteredGuild, reloadGuildRegistry } from './guildRegistry';
import { upsertGuild, getGuildById, findUser, upsertUser, setMemberAccessLevel, AccessLevel } from '../db';
import { runUserMutation } from '../web/routes/adminUserMutationQueue';
import { createLogger } from '../shared/logger';
import { getDiscordClient, setDiscordClient } from './discordClientStore';

const log = createLogger('Discord');

let bootingClient: Client | null = null;

export { getDiscordClient };

/** Resolve callbacks awaiting the next `clientReady` — see {@link onceDiscordReady}. */
let readyWaiters: Array<() => void> = [];

/**
 * Resolves once the Discord client has fired `clientReady` (immediately, if it already has by
 * the time this is called). Lets a caller that needs the client to actually be usable — e.g.
 * `index.ts`'s `announceStartup()`, which sends a DM through it — wait for that without
 * `startDiscordBot()` itself becoming blocking (it stays fire-and-forget, matching the rest of
 * the boot sequence). Never resolves if the client fails to connect and is never retried; pair
 * with `withTimeout` at the call site if that matters there.
 * @returns Resolves with no value once the client is ready.
 */
export function onceDiscordReady(): Promise<void> {
  if (getDiscordClient()) return Promise.resolve();
  return new Promise((resolve) => { readyWaiters.push(resolve); });
}

/**
 * Resolve a guild by ID from the discord.js cache, falling back to a fetch.
 * @throws if the client is not ready.
 */
async function getGuild(guildId: string): Promise<Guild> {
  const client = getDiscordClient();
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
  if (!getDiscordClient()) return null;
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
      await upsertUser(owner.id, owner.user.username, AccessLevel.USER);
    }
    await setMemberAccessLevel(guild.id, owner.id, AccessLevel.ADMIN);
  });
  log.info(`Granted Admin access to server owner ${owner.user.tag} (${owner.id}) for guild '${guild.name}' (${guild.id}).`);
}

/**
 * Dispatches every non-bot message from a registered guild to each command handler in turn
 * (fire-and-forget — a failure in one handler must not block the others). A DM (no guildId)
 * skips the guild-gated handlers entirely and only reaches the owner-only `!health` command,
 * which is designed to be triggered from a DM (see its own docstring).
 * @param client - The Discord client to register the handler on.
 */
function registerMessageCreateHandler(client: Client): void {
  client.on('messageCreate', (message) => {
    if (message.author.bot) return;

    if (!message.guildId) {
      fireAndForget(executeHealthCommandForDiscord(message), 'Health command error', log);
      return;
    }
    if (!isRegisteredGuild(message.guildId)) return;

    const displayName = message.member?.displayName ?? message.author.username;
    const guildId = message.guildId;
    // Parsed once and threaded into every handler below instead of each one re-parsing
    // the same message independently.
    const command = extractCommand(message.content);

    fireAndForget(executeCustomCommandForDiscord(message, displayName, guildId, command), 'Custom command error', log);
    fireAndForget(executeCounterCommandForDiscord(message, displayName, command), 'Counter command error', log);
    fireAndForget(handleCommand(message.content, 'discord', guildId, command), 'Command handler error', log);
    fireAndForget(executeHealthCommandForDiscord(message, command), 'Health command error', log);
  });
}

/**
 * Bootstrap: when the bot is added to a server for the first time, record the
 * guild row and auto-grant the Discord server's owner Admin access to it, so
 * they can self-serve the panel without the bot owner manually provisioning the
 * first member. guildCreate also fires on reconnect, and `guild` rows are never
 * deleted on leave, so the owner grant runs only the first time a guild_id is
 * ever seen (detected via getGuildById returning null beforehand) — never on a
 * reconnect or a kick-then-reinvite. This preserves the existing invariant that
 * a deliberately de-provisioned guild (all members removed) stays inert until
 * someone manually re-provisions it; upsertGuild itself is insert-if-not-exists
 * and never wipes existing per-guild config.
 * @param client - The Discord client to register the handler on.
 */
function registerGuildCreateHandler(client: Client): void {
  client.on('guildCreate', (guild) => {
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
function registerGuildDeleteHandler(client: Client): void {
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

/**
 * Registers the one-shot `clientReady` handler that promotes `client` from `bootingClient` to
 * the module-level ready client, unless {@link stopDiscordBot} discarded it mid-boot.
 * @param client - The booting Discord client to register the handler on.
 */
function registerClientReadyHandler(client: Client): void {
  client.once('clientReady', async (c) => {
    if (bootingClient !== client) {
      // stopDiscordBot() ran during boot — discard this ready client
      await c.destroy().catch(() => { /* ignore */ });
      return;
    }
    bootingClient = null;
    setDiscordClient(c);
    log.info(`Logged in as ${c.user.tag}`);
    setDiscordReady(c.user.tag);
    recordDiscordConnected(true);
    const waiters = readyWaiters;
    readyWaiters = [];
    waiters.forEach((resolve) => { resolve(); });
  });
}

/**
 * Registers gateway-connection visibility/self-healing handlers.
 *
 * discord.js's own WebSocketManager already retries every recoverable gateway
 * disconnect on its own (reflected by 'shardReconnecting'), so most of these are purely
 * visibility logging — without them, a reconnect cycle produces zero log output,
 * making post-incident diagnosis impossible. 'shardError' is a connection-level
 * error on the gateway socket itself (distinct from the generic 'error' handler);
 * the manager keeps retrying after it, so it's also log-only.
 *
 * 'shardDisconnect' fires only for an unrecoverable close code — the one case
 * where discord.js gives up and will *not* reconnect that shard on its own. With
 * this bot running a single (unsharded) client, that means every guild silently
 * stops receiving events. Force a fresh login so the process self-heals instead
 * of sitting alive-but-dead until someone notices and restarts it manually.
 * @param client - The Discord client to register the handlers on.
 */
function registerConnectionHandlers(client: Client): void {
  client.on('error', (err) => {
    log.error('Client error:', err);
  });
  client.on('shardReconnecting', (shardId) => {
    log.warn(`Shard ${shardId} lost its connection and is reconnecting...`);
  });
  client.on('shardError', (err, shardId) => {
    log.error(`Shard ${shardId} gateway connection error:`, err);
  });
  client.on('shardDisconnect', (event, shardId) => {
    log.error(`Shard ${shardId} disconnected permanently (code ${event.code}) — reconnecting client.`);
    recordDiscordConnected(false);
    stopDiscordBot();
    startDiscordBot();
  });
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
  if (getDiscordClient() || bootingClient) return;
  const localClient = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
      GatewayIntentBits.GuildVoiceStates,
      GatewayIntentBits.DirectMessages,
    ],
    partials: [Partials.Channel],
  });
  bootingClient = localClient;

  registerMessageCreateHandler(localClient);
  registerGuildCreateHandler(localClient);
  registerGuildDeleteHandler(localClient);
  registerClientReadyHandler(localClient);
  registerConnectionHandlers(localClient);

  localClient.login(DISCORD_TOKEN).catch((err) => {
    log.error('Login failed:', err);
    bootingClient = null; // clear so the next startDiscordBot() call can retry
  });
}

/**
 * Disconnect and destroy the Discord client, including any client that is
 * still connecting. Idempotent — safe to call before {@link startDiscordBot}.
 * `destroy()` rejections are caught and logged rather than left unhandled.
 * Records the Discord connection as down in `healthStore` before tearing down.
 */
export function stopDiscordBot(): void {
  const existingReady = getDiscordClient();
  const existingBooting = bootingClient;
  setDiscordClient(null);
  bootingClient = null;
  recordDiscordConnected(false);
  existingReady?.destroy().catch((err: unknown) => log.error('Error destroying client:', err));
  existingBooting?.destroy().catch((err: unknown) => log.error('Error destroying booting client:', err));
  log.info('Client destroyed.');
}
