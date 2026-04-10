import 'express-session';
import 'express-serve-static-core';

export interface SessionUser {
  discordId: string;
  discordName: string;
  discordAvatar: string | null;
  accessLevel: 0 | 1 | 2 | 3;
}

declare module 'express-session' {
  interface SessionData {
    user?: SessionUser;
    oauthState?: string;
    csrfToken?: string;
  }
}

declare module 'express-serve-static-core' {
  interface Request {
    csrfToken(): string;
  }
}

export {};
