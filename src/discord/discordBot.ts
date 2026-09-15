import { Client, GatewayIntentBits, Guild, Partials } from 'discord.js';
import { DISCORD_TOKEN } from '../shared/config';
import { handleCommand, forgetGuildCommandState } from '../commands/commandRouter';
import { fireAndForget, extractCommand } from '../commands/commandUtils';
import { executeCustomCommandForDiscord, forgetGuildCustomCommandCooldown } from '../commands/customCommandHandler';
import { executeCounterCommandForDiscord, forgetGuildCounterCooldown } from '../commands/counterHandler';
import { setDiscordReady, clearVoiceStatus } from '../shared/statusStore';
import { recordDiscordConnected } from '../shared/healthStore';
import { executeHealthCommandForDiscord } from '../commands/healthCommandHandler';
import { forgetGuild as forgetGuildVoiceState, disconnect as disconnectAllVoice } from '../audio/audioPlayer';
import { forgetGuildRefreshState } from './guildRefreshState';
import { isRegisteredGuild, reloadGuildRegistry } from './guildRegistry';
import { sendOwnerAlert } from './ownerAlerts';
import { upsertGuild, getGuildById, findUser, upsertUser, setMemberAccessLevel, AccessLevel } from '../db';
import { runUserMutation } from '../web/routes/adminUserMutationQueue';
import { createLogger } from '../shared/logger';
import { getDiscordClient, setDiscordClient } from './discordClientStore';

const log = createLogger('Discord');

let bootingClient: Client | null = null;

export { getDiscordClient };

// ─── Reconnect backoff ──────────────────────────────────────────────────────
//
// startDiscordBot()'s login() call can itself fail (a transient Discord outage exactly
// overlapping a shardDisconnect self-heal, a revoked token, network unreachability at that
// instant) — without a retry loop here, that single failed attempt would leave the process
// alive-but-permanently-disconnected from Discord for the rest of its life, since nothing else
// ever calls startDiscordBot() again. Mirrors audioPlayer.ts's per-guild voice reconnect backoff.

const RECONNECT_BASE_DELAY_MS = 5_000;
const RECONNECT_MAX_DELAY_MS = 5 * 60_000;
let reconnectAttempts = 0;
let reconnectTimer: NodeJS.Timeout | null = null;

/** Cancels and nulls any pending Discord reconnect timer. */
function clearReconnectTimer(): void {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
}

/** Schedules an exponential-backoff retry of {@link startDiscordBot}, skipping if one is already pending. */
function scheduleReconnect(reason: string): void {
  if (reconnectTimer) return;
  const delay = Math.min(RECONNECT_BASE_DELAY_MS * 2 ** reconnectAttempts, RECONNECT_MAX_DELAY_MS);
  reconnectAttempts += 1;
  log.warn(`Scheduling Discord reconnect in ${delay}ms (${reason}).`);
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    startDiscordBot();
  }, delay).unref();
}

/** How often a given shard's gateway connection errors are actually logged — see {@link logShardError}. */
const SHARD_ERROR_LOG_INTERVAL_MS = 60_000;

/** Per-shard state for {@link logShardError}: when it last actually logged, and how many errors it has swallowed since. */
const shardErrorLogState = new Map<number, { lastLoggedAt: number; suppressedCount: number }>();

/**
 * Logs a `shardError` at `error` and DMs the owner, throttled to at most one line/DM per
 * shard per {@link SHARD_ERROR_LOG_INTERVAL_MS}. During a Discord-side gateway hiccup (e.g.
 * repeated `Unexpected server response: 503`), discord.js's automatic reconnect can retry —
 * and this event can fire — many times a second; logging (and alerting on) every one of those
 * verbatim has filled multiple log files in a single incident without adding any information
 * discord.js's own retry wasn't already handling. Errors swallowed during the throttle window
 * are counted and folded into the next line/DM that does get sent. Still worth surfacing as an
 * error (unlike 'shardReconnecting') because a shard that keeps erroring is a real, ongoing
 * connectivity problem worth a human looking at, even though discord.js itself will keep
 * retrying without help.
 * @param shardId - The shard that reported the error.
 * @param err - The gateway connection error.
 */
function logShardError(shardId: number, err: Error): void {
  const now = Date.now();
  const state = shardErrorLogState.get(shardId);
  if (state && now - state.lastLoggedAt < SHARD_ERROR_LOG_INTERVAL_MS) {
    state.suppressedCount++;
    return;
  }
  const suppressed = state?.suppressedCount ?? 0;
  const suffix = suppressed > 0 ? ` (${suppressed} more suppressed in the last ${SHARD_ERROR_LOG_INTERVAL_MS / 1000}s)` : '';
  log.error(`Shard ${shardId} gateway connection error:${suffix}`, err);
  shardErrorLogState.set(shardId, { lastLoggedAt: now, suppressedCount: 0 });
  void sendOwnerAlert(`🔴 Shard ${shardId} gateway connection error${suffix}: ${err.message}`);
}

// ─── Gateway stall watchdog ─────────────────────────────────────────────────
//
// discord.js's own WebSocketManager is documented (see registerConnectionHandlers's docstring)
// as retrying every recoverable gateway disconnect on its own, forever, without our help. In
// practice that retry loop can itself get stuck — observed in production as a run of
// 'shardReconnecting'/'shardError' events during a sustained `Unexpected server response: 503`
// incident, followed by total silence: no further 'shardReconnecting', 'shardError', 'shardReady'
// or 'shardDisconnect' for many minutes, well beyond discord.js's own reconnect backoff (which
// caps out well under a minute). Because that failure mode never reaches 'shardDisconnect' (no
// close code — the socket never even opened), the self-heal in registerConnectionHandlers never
// fires either, leaving the process alive-but-permanently-disconnected until someone notices and
// restarts it manually. This watchdog is the fallback: if no shard activity of any kind is seen
// for GATEWAY_STALL_THRESHOLD_MS while not fully connected, force a fresh login exactly as
// 'shardDisconnect' does.

/** How often {@link checkGatewayStall} polls for a stuck gateway reconnect loop. */
const GATEWAY_STALL_CHECK_INTERVAL_MS = 30_000;

/**
 * How long the gateway may go without any shard activity (reconnect attempt, error, ready,
 * resume) before {@link checkGatewayStall} treats discord.js's own retry loop as stuck and forces
 * a fresh login. Well above discord.js's own reconnect backoff ceiling, so a slow-but-still-live
 * retry cycle never false-positives.
 */
const GATEWAY_STALL_THRESHOLD_MS = 120_000;

let lastShardActivityAt = Date.now();
let gatewayWatchdogTimer: NodeJS.Timeout | null = null;

/** Stamps `lastShardActivityAt` with the current time — called from every shard lifecycle event. */
function recordShardActivity(): void {
  lastShardActivityAt = Date.now();
}

/**
 * Polled every {@link GATEWAY_STALL_CHECK_INTERVAL_MS}: if the client isn't fully connected and
 * no shard activity has been recorded for {@link GATEWAY_STALL_THRESHOLD_MS}, discord.js's own
 * reconnect loop is presumed stuck. Logs, DMs the owner, and forces a fresh login the same way
 * `shardDisconnect` does (including tearing down orphaned voice connections first).
 */
function checkGatewayStall(): void {
  if (getDiscordClient()) return;
  const stalledForMs = Date.now() - lastShardActivityAt;
  if (stalledForMs < GATEWAY_STALL_THRESHOLD_MS) return;
  const stalledForSec = Math.round(stalledForMs / 1000);
  log.error(`No Discord gateway activity for ${stalledForSec}s — the reconnect loop appears stuck; forcing a fresh login.`);
  void sendOwnerAlert(`🔴 Discord gateway reconnect appears stuck (no activity for ${stalledForSec}s) — forcing a fresh login.`);
  disconnectAllVoice();
  stopDiscordBot();
  startDiscordBot();
}

/** Starts the gateway stall watchdog interval, if not already running. Unref'd so it never blocks process exit. */
function startGatewayWatchdog(): void {
  if (gatewayWatchdogTimer) return;
  gatewayWatchdogTimer = setInterval(checkGatewayStall, GATEWAY_STALL_CHECK_INTERVAL_MS).unref();
}

/** Stops and clears the gateway stall watchdog interval, if running. */
function stopGatewayWatchdog(): void {
  if (gatewayWatchdogTimer) {
    clearInterval(gatewayWatchdogTimer);
    gatewayWatchdogTimer = null;
  }
}

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
    fireAndForget(executeCounterCommandForDiscord(message, displayName, guildId, command), 'Counter command error', log);
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
    clearReconnectTimer();
    reconnectAttempts = 0;
    recordShardActivity();
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
 * the manager keeps retrying after it, so it doesn't need any recovery action here —
 * but it's still worth an error-level log and an owner DM, throttled (see
 * {@link logShardError}) so a burst of retries during an outage doesn't flood either.
 *
 * 'shardDisconnect' fires only for an unrecoverable close code — the one case
 * where discord.js gives up and will *not* reconnect that shard on its own. With
 * this bot running a single (unsharded) client, that means every guild silently
 * stops receiving events. Force a fresh login so the process self-heals instead
 * of sitting alive-but-dead until someone notices and restarts it manually.
 *
 * 'shardError' also flips the health store's `discordConnected` flag to `false` —
 * without this, a shard stuck in a reconnect-retry loop (e.g. a sustained run of
 * `Unexpected server response: 503` on every attempt) never fires `shardDisconnect`
 * (discord.js keeps retrying rather than giving up) and never re-fires `clientReady`
 * (that only fires once per client lifetime), so nothing else would ever mark the
 * bot as down — the `!health` command goes unanswered (expected, the gateway is
 * down) while the web panel's health dashboard kept reading the last-known `true`
 * forever. 'shardReady'/'shardResume' flip it back to `true` once the shard
 * actually recovers, since a full client replacement (via `clientReady`) isn't
 * guaranteed to happen for every recovery path.
 *
 * `stopDiscordBot()`/`startDiscordBot()` destroy the old `Client` and construct a brand-new one —
 * `audioPlayer.ts`'s custom (non-`voiceAdapterCreator`) voice adapter isn't registered with
 * discord.js's own voice manager, so `Client.destroy()` doesn't tear down any active
 * `VoiceConnection`s for us. Left alone, a guild connected to voice when the shard drops would be
 * orphaned: its `GuildVoiceState.client` and adapter dispatcher entry still reference the
 * destroyed client, so it can never receive gateway voice updates again and
 * `scheduleReconnect` would retry forever against a dead client. `disconnectAllVoice()` (no
 * `guildId` — every guild, since every one of them loses its client here) tears every guild's
 * voice connection down first, so each cleanly reconnects once `startDiscordBot()`'s new client
 * is ready, the same way it would after a normal `!voice` disconnect.
 * @param client - The Discord client to register the handlers on.
 */
function registerConnectionHandlers(client: Client): void {
  client.on('error', (err) => {
    log.error('Client error:', err);
  });
  client.on('shardReconnecting', (shardId) => {
    recordShardActivity();
    log.warn(`Shard ${shardId} lost its connection and is reconnecting...`);
  });
  client.on('shardError', (err, shardId) => {
    recordShardActivity();
    recordDiscordConnected(false);
    logShardError(shardId, err);
  });
  client.on('shardReady', () => {
    recordShardActivity();
    recordDiscordConnected(true);
  });
  client.on('shardResume', () => {
    recordShardActivity();
    recordDiscordConnected(true);
  });
  client.on('shardDisconnect', (event, shardId) => {
    recordShardActivity();
    log.error(`Shard ${shardId} disconnected permanently (code ${event.code}) — reconnecting client.`);
    recordDiscordConnected(false);
    disconnectAllVoice();
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
 * If login fails, `bootingClient` is cleared and a backoff retry of this function is scheduled
 * automatically (see {@link scheduleReconnect}) — a caller never needs to retry manually.
 *
 * The guild registry must be loaded (see {@link reloadGuildRegistry}) before the
 * client connects, so the `messageCreate` gate can recognise registered guilds.
 *
 * Also (re)starts the gateway stall watchdog (see the "Gateway stall watchdog" section above)
 * and resets its activity clock, so a fresh boot always gets a full {@link GATEWAY_STALL_THRESHOLD_MS}
 * before it could be judged stuck.
 */
export function startDiscordBot(): void {
  if (getDiscordClient() || bootingClient) return;
  recordShardActivity();
  startGatewayWatchdog();
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
    // A stopDiscordBot() (or a newer startDiscordBot()) may have already moved bootingClient
    // past this login attempt by the time it rejects — e.g. the bot was told to stop while this
    // login was still pending. In that case this rejection is stale: touching bootingClient or
    // scheduling a reconnect here would either restart a bot that was told to stop, or clobber
    // tracking for a genuinely newer boot attempt already in progress.
    if (bootingClient !== localClient) return;
    bootingClient = null; // clear so a retry can call startDiscordBot() again
    scheduleReconnect('login failed');
  });
}

/**
 * Disconnect and destroy the Discord client, including any client that is
 * still connecting. Idempotent — safe to call before {@link startDiscordBot}.
 * `destroy()` rejections are caught and logged rather than left unhandled.
 * Records the Discord connection as down in `healthStore` before tearing down.
 * Also stops the gateway stall watchdog — restarted fresh by the next {@link startDiscordBot}.
 */
export function stopDiscordBot(): void {
  const existingReady = getDiscordClient();
  const existingBooting = bootingClient;
  setDiscordClient(null);
  bootingClient = null;
  clearReconnectTimer();
  stopGatewayWatchdog();
  recordDiscordConnected(false);
  existingReady?.destroy().catch((err: unknown) => log.error('Error destroying client:', err));
  existingBooting?.destroy().catch((err: unknown) => log.error('Error destroying booting client:', err));
  log.info('Client destroyed.');
}
