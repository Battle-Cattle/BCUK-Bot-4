import type { AlertEventType } from '../../db';

/**
 * Realistic sample template variables per event type, used only to preview what a real,
 * substituted message would look like when a streamer clicks "Send Test Alert" — mirrors the
 * variable names actually built for each handler in `twitchEventSubHandler.ts`. Kept in its own
 * dependency-free module (rather than inline in `alertsAdminMutations.ts`) so a cross-file
 * regression test can import it without pulling in that route module's Express/DB/config
 * dependencies, and assert these keys stay in sync with what the real handlers build.
 */
export const TEST_ALERT_VARS: Record<AlertEventType, Record<string, string>> = {
  follow: { username: 'testuser', display_name: 'TestUser' },
  sub: { username: 'testuser', display_name: 'TestUser', tier: '1000', tier_name: 'Tier 1' },
  resub: { username: 'testuser', display_name: 'TestUser', tier: '1000', tier_name: 'Tier 1', months: '6', streak: '3' },
  giftsub: { gifter: 'testgifter', gifter_display: 'TestGifter', count: '5', tier: '1000', tier_name: 'Tier 1' },
  raid: { from_channel: 'testraider', from_display: 'TestRaider', viewers: '42' },
};
