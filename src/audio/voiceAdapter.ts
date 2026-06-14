import type {
  DiscordGatewayAdapterCreator,
  DiscordGatewayAdapterImplementerMethods,
  DiscordGatewayAdapterLibraryMethods,
} from '@discordjs/voice';
import type { VoiceBasedChannel } from 'discord.js';

// ─── Voice adapter ────────────────────────────────────────────────────────────
// Bypasses discord.js's built-in voiceAdapterCreator to avoid type/version
// incompatibilities with discord.js v14. Listens to raw gateway events instead.
//
// The pieces are kept as flat module-level helpers (rather than closures nested
// inside the factory) so each stays simple and independently testable.

type RawPacket = { t: string; d: Record<string, unknown> };

/** Tracks the cleanup for a guild's currently-registered adapter listener. */
interface AdapterCleanupState {
  activeCleanup: (() => void) | null;
}

function makeOnRaw(methods: DiscordGatewayAdapterLibraryMethods): (packet: RawPacket) => void {
  return function onRaw(packet: RawPacket): void {
    if (packet.t === 'VOICE_STATE_UPDATE') {
      methods.onVoiceStateUpdate(packet.d as unknown as Parameters<typeof methods.onVoiceStateUpdate>[0]);
    }
    if (packet.t === 'VOICE_SERVER_UPDATE') {
      methods.onVoiceServerUpdate(packet.d as unknown as Parameters<typeof methods.onVoiceServerUpdate>[0]);
    }
  };
}

/** Builds the idempotent cleanup that removes the raw listener and decrements the cap. */
function makeCleanup(
  channel: VoiceBasedChannel,
  onRaw: (packet: RawPacket) => void,
  increment: number,
  state: AdapterCleanupState,
): () => void {
  let cleanedUp = false;
  return function cleanup(): void {
    if (cleanedUp) return;
    cleanedUp = true;
    channel.client.off('raw', onRaw);
    // Decrement rather than restore to a snapshot so that cross-guild adapters
    // sharing the same client do not race each other's cap bookkeeping.
    if (increment > 0) channel.client.setMaxListeners(channel.client.getMaxListeners() - increment);
    state.activeCleanup = null;
  };
}

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
 * previous adapter first so listeners do not accumulate across reconnects.
 */
function registerAdapter(
  channel: VoiceBasedChannel,
  methods: DiscordGatewayAdapterLibraryMethods,
  state: AdapterCleanupState,
): DiscordGatewayAdapterImplementerMethods {
  if (state.activeCleanup) state.activeCleanup();

  const onRaw = makeOnRaw(methods);
  const currentMax = channel.client.getMaxListeners();
  // 0 means unlimited — don't touch it.
  const increment = currentMax !== 0 ? 1 : 0;
  if (increment > 0) channel.client.setMaxListeners(currentMax + 1);
  channel.client.on('raw', onRaw);

  const cleanup = makeCleanup(channel, onRaw, increment, state);
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
