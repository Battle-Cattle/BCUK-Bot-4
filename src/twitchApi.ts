import { TWITCH_CLIENT_ID, TWITCH_CLIENT_SECRET } from './config';

const FETCH_TIMEOUT_MS = 10_000;

async function twitchFetch(url: string, init?: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

let cachedAppToken: string | null = null;
let appTokenExpiry = 0;

async function getAppToken(): Promise<string> {
  if (cachedAppToken && Date.now() < appTokenExpiry) return cachedAppToken;

  const body = new URLSearchParams({
    client_id: TWITCH_CLIENT_ID,
    client_secret: TWITCH_CLIENT_SECRET,
    grant_type: 'client_credentials',
  });

  const res = await twitchFetch('https://id.twitch.tv/oauth2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });

  if (!res.ok) throw new Error(`[TwitchAPI] Token request failed: ${res.status}`);

  const data = await res.json() as { access_token: string; expires_in: number };
  cachedAppToken = data.access_token;
  // Expire 60 s early to avoid edge cases
  appTokenExpiry = Date.now() + (data.expires_in - 60) * 1000;
  return cachedAppToken;
}

function authHeaders(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    'Client-Id': TWITCH_CLIENT_ID,
  };
}

function chunks<T>(arr: T[], size: number): T[][] {
  const result: T[][] = [];
  for (let i = 0; i < arr.length; i += size) result.push(arr.slice(i, i + size));
  return result;
}

export interface TwitchUser {
  login: string;
  id: string;
}

export async function getUsers(logins: string[]): Promise<TwitchUser[]> {
  if (logins.length === 0) return [];
  const token = await getAppToken();
  const results: TwitchUser[] = [];
  for (const batch of chunks(logins, 100)) {
    const params = batch.map((l) => `login=${encodeURIComponent(l)}`).join('&');
    const res = await twitchFetch(`https://api.twitch.tv/helix/users?${params}`, {
      headers: authHeaders(token),
    });
    if (!res.ok) throw new Error(`[TwitchAPI] getUsers failed: ${res.status}`);
    const data = await res.json() as { data: Array<{ login: string; id: string }> };
    results.push(...data.data.map((u) => ({ login: u.login, id: u.id })));
  }
  return results;
}

export interface TwitchStream {
  user_id: string;
  user_login: string;
  game_name: string;
  title: string;
  thumbnail_url: string;
  /** 'live' when streaming, '' when not */
  type: string;
}

export async function getStreams(userIds: string[]): Promise<TwitchStream[]> {
  if (userIds.length === 0) return [];
  const token = await getAppToken();
  const results: TwitchStream[] = [];
  for (const batch of chunks(userIds, 100)) {
    const params = batch.map((id) => `user_id=${encodeURIComponent(id)}`).join('&');
    const res = await twitchFetch(`https://api.twitch.tv/helix/streams?${params}&first=100`, {
      headers: authHeaders(token),
    });
    if (!res.ok) throw new Error(`[TwitchAPI] getStreams failed: ${res.status}`);
    const data = await res.json() as { data: TwitchStream[] };
    results.push(...data.data);
  }
  return results;
}


