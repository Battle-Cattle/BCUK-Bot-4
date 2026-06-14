import type {
  DiscordGatewayAdapterCreator,
  DiscordGatewayAdapterLibraryMethods,
} from '@discordjs/voice';
import type { VoiceBasedChannel } from 'discord.js';

// ─── Voice adapter ────────────────────────────────────────────────────────────
// Bypasses discord.js's built-in voiceAdapterCreator to avoid type/version
// incompatibilities with discord.js v14. Listens to raw gateway events instead.

type RawPacket = { t: string; d: Record<string, unknown> };

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

/** Builds the gateway adapter creators for one guild's voice connections. */
export interface VoiceAdapterFactory {
  /** Returns an adapter creator bound to the given voice channel. */
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
  let activeCleanup: (() => void) | null = null;

  function build(channel: VoiceBasedChannel): DiscordGatewayAdapterCreator {
    return (methods: DiscordGatewayAdapterLibraryMethods) => {
      // Tear down the previous adapter before registering a new one.
      if (activeCleanup) activeCleanup();

      const onRaw = makeOnRaw(methods);
      const originalMax = channel.client.getMaxListeners();
      // 0 means unlimited — don't touch it.
      if (originalMax !== 0) channel.client.setMaxListeners(originalMax + 1);
      channel.client.on('raw', onRaw);

      let cleanedUp = false;
      const cleanup = (): void => {
        if (cleanedUp) return;
        cleanedUp = true;
        channel.client.off('raw', onRaw);
        if (originalMax !== 0) channel.client.setMaxListeners(originalMax);
        activeCleanup = null;
      };
      activeCleanup = cleanup;

      return {
        sendPayload: (payload: unknown) => {
          try {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            channel.guild.shard.send(payload as any);
            return true;
          } catch {
            return false;
          }
        },
        destroy: cleanup,
      };
    };
  }

  return { build };
}
