import 'express-session';

export interface SessionUser {
  discordId: string;
  discordName: string;
  discordAvatar: string | null;
  accessLevel: number; // 0=USER 1=MOD 2=MANAGER 3=ADMIN
}

declare module 'express-session' {
  interface SessionData {
    user?: SessionUser;
    oauthState?: string;
  }
}

export {};
