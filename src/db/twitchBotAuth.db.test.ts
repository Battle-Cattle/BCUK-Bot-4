import { describe, it, expect } from 'vitest';
import type mysql from 'mysql2/promise';
import { getPool } from './pool';
import { saveBotChatTokenIfLatestAttempt } from './twitchBotAuth';

// saveBotChatTokenIfLatestAttempt's compare-and-swap upsert against a real MySQL (npm run test:db):
// the first save inserts the singleton row, a later-started attempt replaces it, and an
// earlier-started one that finishes last changes nothing.

async function storedUserId(): Promise<string> {
  const [rows] = await getPool().query<mysql.RowDataPacket[]>('SELECT twitch_user_id FROM twitch_bot_chat_token WHERE id = 1');
  return String(rows[0]!.twitch_user_id);
}

describe('saveBotChatTokenIfLatestAttempt (real MySQL)', () => {
  it('lets the most recently started attempt win, whatever order the saves arrive in', async () => {
    expect(await saveBotChatTokenIfLatestAttempt(2, 'bot-2', 'access-2', 'refresh-2', null)).toBe(1);
    expect(await storedUserId()).toBe('bot-2');

    expect(await saveBotChatTokenIfLatestAttempt(1, 'bot-1', 'access-1', 'refresh-1', null)).toBeNull();
    expect(await storedUserId()).toBe('bot-2');

    expect(await saveBotChatTokenIfLatestAttempt(3, 'bot-3', 'access-3', 'refresh-3', null)).toBe(2);
    expect(await storedUserId()).toBe('bot-3');
  });
});
