import 'express-session';
import 'express-serve-static-core';
import { AccessLevel } from '../db';

/** A guild the logged-in user may act in, shown in the guild switcher. */
export interface SessionGuildSummary {
  guildId: string;
  name: string;
}

export interface SessionUser {
  discordId: string;
  discordName: string;
  discordAvatar: string | null;
  /** True for bot owners (user.is_owner): full access to every guild. */
  isOwner: boolean;
  /**
   * Effective access level for `currentGuildId` (owners always resolve to Admin).
   * Recomputed on login and on every guild switch — never trust it across guilds.
   */
  accessLevel: (typeof AccessLevel)[keyof typeof AccessLevel];
  /** The guild the session is currently acting in, or null until one is picked. */
  currentGuildId: string | null;
  /** Guilds this user may switch between (their memberships, or all guilds if owner). */
  guilds: SessionGuildSummary[];
}

declare module 'express-session' {
  interface SessionData {
    user?: SessionUser;
    oauthState?: { value: string; expiresAt: number };
    csrfToken?: string;
    eventsubOAuthState?: { value: string; expiresAt: number };
    eventsubStreamerId?: number;
    /** Pending companion-app loopback OAuth login, set by /companion/login. */
    companionOAuth?: { redirectUri: string; appState: string; expiresAt: number };
  }
}

declare module 'express-serve-static-core' {
  interface Request {
    csrfToken(): string;
    apiKeyOwner?: string;
    /** The guild the Streamdeck API key is bound to, set by requireApiKey. */
    apiKeyGuildId?: string | null;
    /** Discord ID owning the companion app token, set by requireCompanionKey. */
    companionDiscordId?: string;
  }
}

export {};
