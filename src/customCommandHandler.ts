import { getCustomCommandForDiscord, getCustomCommandForTwitchChannel } from './db';
import { recordCommandTestEntry } from './commandTestingStore';

function extractCommand(rawMessage: string): string | null {
  const trimmedMessage = rawMessage.trim();
  if (!trimmedMessage) return null;

  const command = trimmedMessage.split(/\s+/)[0]?.toLowerCase();
  return command || null;
}

export async function previewCustomCommandForDiscord(
  rawMessage: string,
  username?: string | null,
): Promise<void> {
  const command = extractCommand(rawMessage);
  if (!command) return;

  const customCommand = await getCustomCommandForDiscord(command);
  if (!customCommand) return;

  recordCommandTestEntry({
    source: 'discord',
    command,
    response: customCommand.output,
    channel: null,
    user: username ?? null,
  });

  console.log(`[Discord] Preview custom command '${command}' matched; reply suppressed during testing.`);
}

export async function previewCustomCommandForTwitch(
  channel: string,
  rawMessage: string,
  username?: string | null,
): Promise<void> {
  const command = extractCommand(rawMessage);
  if (!command) return;

  const customCommand = await getCustomCommandForTwitchChannel(channel, command);
  if (!customCommand) return;

  recordCommandTestEntry({
    source: 'twitch',
    command,
    response: customCommand.output,
    channel,
    user: username ?? null,
  });

  console.log(`[Twitch] Preview custom command '${command}' matched in ${channel}; reply suppressed during testing.`);
}
