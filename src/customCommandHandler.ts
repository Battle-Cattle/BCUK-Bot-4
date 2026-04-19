import { findCounterByCommand, getCustomCommandForDiscord, getCustomCommandForTwitchChannel } from './db';
import { recordCommandTestEntry } from './commandMonitorStore';

type PreviewLookupResult = {
  response: string;
  logType: 'custom-command' | 'counter-command' | 'counter-check';
};

function extractCommand(rawMessage: string): string | null {
  const trimmedMessage = rawMessage.trim();
  if (!trimmedMessage) return null;

  const command = trimmedMessage.split(/\s+/)[0]?.toLowerCase();
  if (!command) return null;

  const firstChar = command.charAt(0);
  if (!firstChar || /[a-z0-9]/i.test(firstChar)) {
    return null;
  }

  return command;
}

function formatCounterPreviewMessage(template: string, value: number): string {
  return template.replace(/%d/g, String(value));
}

function buildCounterTriggerPreviewResponse(currentValue: number, incrementMessage: string): string {
  const incrementPreview = formatCounterPreviewMessage(incrementMessage, currentValue);
  return `${incrementPreview} (preview only — counter not incremented)`;
}

async function findPreviewLookupResult(
  command: string,
  lookupCustomCommand: (command: string) => Promise<{ output: string } | null>,
): Promise<PreviewLookupResult | null> {
  const customCommand = await lookupCustomCommand(command);
  if (customCommand) {
    return {
      response: customCommand.output,
      logType: 'custom-command',
    };
  }

  const counter = await findCounterByCommand(command);
  if (counter) {
    return {
      response: counter.matchType === 'trigger'
        ? buildCounterTriggerPreviewResponse(counter.current_value, counter.increment_message)
        : formatCounterPreviewMessage(counter.message, counter.current_value),
      logType: counter.matchType === 'trigger' ? 'counter-command' : 'counter-check',
    };
  }

  return null;
}

async function previewCustomCommand(
  rawMessage: string,
  source: 'discord' | 'twitch',
  channel: string | null,
  username: string | null | undefined,
  lookupCommand: (command: string) => Promise<{ output: string } | null>,
  buildLogMessage: (command: string, logType: PreviewLookupResult['logType']) => string,
): Promise<void> {
  const command = extractCommand(rawMessage);
  if (!command) return;

  const matchedEntry = await findPreviewLookupResult(command, lookupCommand);
  if (!matchedEntry) return;

  recordCommandTestEntry({
    source,
    command,
    response: matchedEntry.response,
    channel,
    user: username ?? null,
  });

  console.log(buildLogMessage(command, matchedEntry.logType));
}

export async function previewCustomCommandForDiscord(
  rawMessage: string,
  username?: string | null,
): Promise<void> {
  await previewCustomCommand(
    rawMessage,
    'discord',
    null,
    username,
    getCustomCommandForDiscord,
    (command, logType) => logType === 'counter-check'
      ? `[Discord] Preview counter check '${command}' matched (recorded for monitoring).`
      : logType === 'counter-command'
        ? `[Discord] Preview counter command '${command}' matched (recorded for monitoring).`
        : `[Discord] Preview custom command '${command}' matched (recorded for monitoring).`,
  );
}

export async function previewCustomCommandForTwitch(
  channel: string,
  rawMessage: string,
  username?: string | null,
): Promise<void> {
  await previewCustomCommand(
    rawMessage,
    'twitch',
    channel,
    username,
    (command) => getCustomCommandForTwitchChannel(channel, command),
    (command, logType) => logType === 'counter-check'
      ? `[Twitch] Preview counter check '${command}' matched in ${channel} (recorded for monitoring).`
      : logType === 'counter-command'
        ? `[Twitch] Preview counter command '${command}' matched in ${channel} (recorded for monitoring).`
        : `[Twitch] Preview custom command '${command}' matched in ${channel} (recorded for monitoring).`,
  );
}
