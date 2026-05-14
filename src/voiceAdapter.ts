import {
  type DiscordGatewayAdapterCreator,
  type DiscordGatewayAdapterLibraryMethods,
} from '@discordjs/voice';
import { type VoiceBasedChannel } from 'discord.js';

// Tracks the cleanup function for the currently active raw-event adapter so it
// can be removed before a new one is registered, preventing listener accumulation.
let activeAdapterCleanup: (() => void) | null = null;

/**
 * Build a voice adapter that listens to the raw Discord gateway events.
 * This bypasses any type/version mismatch in discord.js's built-in voiceAdapterCreator.
 */
export function buildAdapter(channel: VoiceBasedChannel): DiscordGatewayAdapterCreator {
  return (methods: DiscordGatewayAdapterLibraryMethods) => {
    // Remove any previous adapter's listener before adding a new one.
    if (activeAdapterCleanup) {
      activeAdapterCleanup();
      activeAdapterCleanup = null;
    }

    function onRaw(packet: { t: string; d: Record<string, unknown> }) {
      if (packet.t === 'VOICE_STATE_UPDATE') {
        methods.onVoiceStateUpdate(packet.d as unknown as Parameters<typeof methods.onVoiceStateUpdate>[0]);
      }
      if (packet.t === 'VOICE_SERVER_UPDATE') {
        methods.onVoiceServerUpdate(packet.d as unknown as Parameters<typeof methods.onVoiceServerUpdate>[0]);
      }
    }

    channel.client.setMaxListeners(channel.client.getMaxListeners() + 1);
    channel.client.on('raw', onRaw);

    function cleanup(): void {
      channel.client.off('raw', onRaw);
      channel.client.setMaxListeners(Math.max(channel.client.getMaxListeners() - 1, 0));
      if (activeAdapterCleanup === cleanup) {
        activeAdapterCleanup = null;
      }
    }

    activeAdapterCleanup = cleanup;

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
