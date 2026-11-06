import type {
  DiscordGatewayAdapterCreator,
  DiscordGatewayAdapterImplementerMethods,
  DiscordGatewayAdapterLibraryMethods,
} from '@discordjs/voice';
import { WebSocketShardEvents } from '@discordjs/ws';
import type { Client, GatewayDispatchPayload, GatewaySendPayload, VoiceBasedChannel } from 'discord.js';
import { createLogger } from '../shared/logger';

const log = createLogger('VoiceAdapter');

// ─── Voice adapter ────────────────────────────────────────────────────────────
// Bypasses discord.js's built-in voiceAdapterCreator to avoid type/version
// incompatibilities between discord.js and @discordjs/voice. Listens to gateway dispatches on
// `client.ws` (the @discordjs/ws manager; discord.js v15 no longer emits 'raw') instead.
//
// Every guild connected to voice shares ONE dispatch listener per Client (registered
// lazily on first use, tracked in `dispatchers` below) instead of each guild adding
// its own — with N guilds in voice, every gateway dispatch event (not just voice
// ones) would otherwise fan out to N separate handlers. The shared listener routes
// each VOICE_STATE_UPDATE/VOICE_SERVER_UPDATE packet to the right guild's methods
// by `packet.d.guild_id`.
//
// The pieces are kept as flat module-level helpers (rather than closures nested
// inside the factory) so each stays simple and independently testable.

/** Tracks the cleanup for a guild's currently-registered adapter methods. */
interface AdapterCleanupState {
  activeCleanup: (() => void) | null;
}

/** Per-`Client` dispatch state: the guilds currently registered for voice packet routing. */
interface ClientDispatcher {
  guildMethods: Map<string, DiscordGatewayAdapterLibraryMethods>;
}

// WeakMap so a client that's discarded (e.g. in tests) doesn't keep its dispatcher alive.
const dispatchers = new WeakMap<Client, ClientDispatcher>();

/**
 * Routes one gateway dispatch to its guild's registered methods, if any. No-ops for non-voice packets or unregistered guilds.
 * @param dispatcher - The client's dispatcher holding per-guild adapter methods.
 * @param packet - Gateway dispatch payload (`t` event name, `d` payload) received on `client.ws`.
 */
function dispatchGatewayPacket(dispatcher: ClientDispatcher, packet: GatewayDispatchPayload): void {
  if (packet.t !== 'VOICE_STATE_UPDATE' && packet.t !== 'VOICE_SERVER_UPDATE') return;

  const guildId = (packet.d as { guild_id?: string }).guild_id;
  if (!guildId) return;

  const methods = dispatcher.guildMethods.get(guildId);
  if (!methods) return;

  if (packet.t === 'VOICE_STATE_UPDATE') {
    methods.onVoiceStateUpdate(packet.d);
  } else {
    methods.onVoiceServerUpdate(packet.d);
  }
}

/**
 * Returns `client`'s shared dispatcher, registering its single gateway dispatch listener on first use.
 * @param client - Discord client whose gateway dispatches to route.
 * @returns The client's existing or newly registered dispatcher.
 */
function getOrCreateDispatcher(client: Client): ClientDispatcher {
  const existing = dispatchers.get(client);
  if (existing) return existing;

  const dispatcher: ClientDispatcher = { guildMethods: new Map() };
  /** Forwards each gateway dispatch from `client` to this dispatcher's routing logic. */
  client.ws.on(WebSocketShardEvents.Dispatch, (packet) => dispatchGatewayPacket(dispatcher, packet));
  dispatchers.set(client, dispatcher);
  return dispatcher;
}

/**
 * Creates the gateway payload sender that routes voice data through the channel's guild shard.
 * discord.js v15 sends via `client.ws.send(shardId, …)`, which may be async: a synchronous throw
 * reports failure, and a later rejection is logged rather than left unhandled.
 * @param channel - Voice channel whose guild shard the payloads are sent through.
 * @returns A sender returning true if the payload was handed to the shard, false if the send threw.
 */
function makeSendPayload(channel: VoiceBasedChannel): (payload: unknown) => boolean {
  return function sendPayload(payload: unknown): boolean {
    try {
      const sent = channel.client.ws.send(channel.guild.shardId, payload as GatewaySendPayload);
      Promise.resolve(sent).catch((err: unknown) => {
        log.warn(`Voice gateway payload send failed for guild ${channel.guild.id}:`, err);
      });
      return true;
    } catch {
      return false;
    }
  };
}

/**
 * Registers a gateway-dispatch adapter for one connection, tearing down the guild's
 * previous adapter first so registrations do not accumulate across reconnects.
 * @param channel - Voice channel the connection is joining.
 * @param methods - Library methods from @discordjs/voice that receive voice state and server updates.
 * @param state - The guild's adapter cleanup state, holding the previous registration's cleanup.
 * @returns Implementer methods for @discordjs/voice: a payload sender and an idempotent destroy.
 */
function registerAdapter(
  channel: VoiceBasedChannel,
  methods: DiscordGatewayAdapterLibraryMethods,
  state: AdapterCleanupState,
): DiscordGatewayAdapterImplementerMethods {
  if (state.activeCleanup) state.activeCleanup();

  const dispatcher = getOrCreateDispatcher(channel.client);
  const guildId = channel.guild.id;
  dispatcher.guildMethods.set(guildId, methods);

  let cleanedUp = false;
  /**
   * Removes this registration's entry from the dispatcher, but only if it hasn't already
   * been superseded by a newer registration for the same guild. Idempotent.
   */
  const cleanup = (): void => {
    if (cleanedUp) return;
    cleanedUp = true;
    // Only remove this guild's entry if it still points at these methods — a newer
    // registration's cleanup must never be able to clobber a more recent one.
    if (dispatcher.guildMethods.get(guildId) === methods) {
      dispatcher.guildMethods.delete(guildId);
    }
    state.activeCleanup = null;
  };
  state.activeCleanup = cleanup;

  return { sendPayload: makeSendPayload(channel), destroy: cleanup };
}

/** Builds the gateway adapter creators for one guild's voice connections. */
export interface VoiceAdapterFactory {
  /**
   * Returns an adapter creator bound to the given voice channel.
   *
   * @param channel - The voice channel the adapter will relay gateway events for.
   * @returns A `DiscordGatewayAdapterCreator` that can be passed to `joinVoiceChannel`.
   */
  build(channel: VoiceBasedChannel): DiscordGatewayAdapterCreator;
}

/**
 * Creates a per-guild adapter factory that tracks the active gateway-dispatch listener
 * and tears down the previous one before registering a new adapter, so listeners
 * never accumulate across that guild's reconnects.
 *
 * @returns A factory whose `build` produces channel-bound adapter creators.
 */
export function createVoiceAdapterFactory(): VoiceAdapterFactory {
  const state: AdapterCleanupState = { activeCleanup: null };
  return {
    build: (channel) => (methods) => registerAdapter(channel, methods, state),
  };
}
