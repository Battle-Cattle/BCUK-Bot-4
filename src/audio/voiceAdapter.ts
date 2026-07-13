import type {
  DiscordGatewayAdapterCreator,
  DiscordGatewayAdapterImplementerMethods,
  DiscordGatewayAdapterLibraryMethods,
} from '@discordjs/voice';
import type { Client, VoiceBasedChannel } from 'discord.js';

// ─── Voice adapter ────────────────────────────────────────────────────────────
// Bypasses discord.js's built-in voiceAdapterCreator to avoid type/version
// incompatibilities with discord.js v14. Listens to raw gateway events instead.
//
// Every guild connected to voice shares ONE 'raw' listener per Client (registered
// lazily on first use, tracked in `dispatchers` below) instead of each guild adding
// its own — with N guilds in voice, every gateway dispatch event (not just voice
// ones) would otherwise fan out to N separate handlers. The shared listener routes
// each VOICE_STATE_UPDATE/VOICE_SERVER_UPDATE packet to the right guild's methods
// by `packet.d.guild_id`.
//
// The pieces are kept as flat module-level helpers (rather than closures nested
// inside the factory) so each stays simple and independently testable.

type RawPacket = { t: string; d: Record<string, unknown> };

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

/** Routes one raw gateway packet to its guild's registered methods, if any. No-ops for non-voice packets or unregistered guilds. */
function dispatchRawPacket(dispatcher: ClientDispatcher, packet: RawPacket): void {
  if (packet.t !== 'VOICE_STATE_UPDATE' && packet.t !== 'VOICE_SERVER_UPDATE') return;

  const guildId = (packet.d as { guild_id?: string }).guild_id;
  if (!guildId) return;

  const methods = dispatcher.guildMethods.get(guildId);
  if (!methods) return;

  if (packet.t === 'VOICE_STATE_UPDATE') {
    methods.onVoiceStateUpdate(packet.d as unknown as Parameters<typeof methods.onVoiceStateUpdate>[0]);
  } else {
    methods.onVoiceServerUpdate(packet.d as unknown as Parameters<typeof methods.onVoiceServerUpdate>[0]);
  }
}

/** Returns `client`'s shared dispatcher, registering its single 'raw' listener on first use. */
function getOrCreateDispatcher(client: Client): ClientDispatcher {
  const existing = dispatchers.get(client);
  if (existing) return existing;

  const dispatcher: ClientDispatcher = { guildMethods: new Map() };
  client.on('raw', (packet: RawPacket) => dispatchRawPacket(dispatcher, packet));
  dispatchers.set(client, dispatcher);
  return dispatcher;
}

/** Creates the gateway payload sender that routes voice data through the channel's guild shard. */
function makeSendPayload(channel: VoiceBasedChannel): (payload: unknown) => boolean {
  return function sendPayload(payload: unknown): boolean {
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      channel.guild.shard.send(payload as any);
      return true;
    } catch {
      return false;
    }
  };
}

/**
 * Registers a raw-gateway adapter for one connection, tearing down the guild's
 * previous adapter first so registrations do not accumulate across reconnects.
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
 * Creates a per-guild adapter factory that tracks the active raw-gateway listener
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
