import { type Client } from 'discord.js';

let client: Client | null = null;

/** Returns the Discord.js Client once it has fired `clientReady`, or null before then. */
export function getDiscordClient(): Client | null { return client; }

/** Sets the current Discord.js Client instance (or null on shutdown). */
export function setDiscordClient(c: Client | null): void { client = c; }
