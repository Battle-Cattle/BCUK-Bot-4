// Routes Discord messages to the command handlers. Registered on each new client by
// `discordBot.ts`, which owns the client itself (login, reconnects, gateway health).
import type { Client } from 'discord.js';
import { handleCommand } from '../commands/commandRouter';
import { fireAndForget, extractCommand } from '../commands/commandUtils';
import { executeCustomCommandForDiscord } from '../commands/customCommandHandler';
import { executeCounterCommandForDiscord } from '../commands/counterHandler';
import { executeHealthCommandForDiscord } from '../commands/healthCommandHandler';
import { isRegisteredGuild } from './guildRegistry';
import { createLogger } from '../shared/logger';

const log = createLogger('Discord');

/**
 * Dispatches every non-bot message from a registered guild to each command handler in turn
 * (fire-and-forget — a failure in one handler must not block the others). A DM (no guildId)
 * skips the guild-gated handlers entirely and only reaches the owner-only `!health` command,
 * which is designed to be triggered from a DM (see its own docstring).
 * @param client - The Discord client to register the handler on.
 */
export function registerMessageCreateHandler(client: Client): void {
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
