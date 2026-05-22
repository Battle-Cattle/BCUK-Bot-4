import { createLogger } from '../../logger';
import { Router } from 'express';
import { randomBytes } from 'crypto';
import { findUser, getStreamerByDiscordId, saveEventConfig, clearStreamerToken, EventSubConfig } from '../../db';
import { csrfProtection } from '../csrf';
import { requireAuth } from '../middleware';
import { reloadEventSubSubscriptions } from '../../twitchEventSub';
import { TWITCH_CLIENT_ID, TWITCH_EVENTSUB_REDIRECT_URI, EVENTSUB_TOKEN_SECRET } from '../../config';

const log = createLogger('Web');
const router = Router();

const TWITCH_OAUTH_SCOPE = 'moderator:read:followers channel:read:subscriptions';

const KNOWN_ERRORS = new Set([
  'no_streamer_record',
  'eventsub_not_bot_enabled',
  'eventsub_config_failed',
  'eventsub_disconnect_failed',
  'eventsub_oauth_denied',
  'eventsub_oauth_state_mismatch',
  'eventsub_token_invalid',
  'eventsub_wrong_account',
  'invalid_id',
]);

const ERROR_MESSAGES: Record<string, string> = {
  no_streamer_record:            'You are not configured as a monitored streamer.',
  eventsub_not_bot_enabled:      'The Twitch bot must be enabled for your channel before you can configure notifications. Contact a Manager or Admin.',
  eventsub_config_failed:        'Failed to save notification config. Please try again.',
  eventsub_disconnect_failed:    'Failed to disconnect Twitch account. Please try again.',
  eventsub_oauth_denied:         'Twitch authorization was denied.',
  eventsub_oauth_state_mismatch: 'Authorization failed — please try connecting again.',
  eventsub_token_invalid:        'Could not verify the Twitch account. Please try again.',
  eventsub_wrong_account:        'Wrong Twitch account — please authorize with your own broadcaster account.',
  invalid_id:                    'Invalid request — please try again.',
};

function getFriendlyError(key: string): string {
  return ERROR_MESSAGES[key] ?? `An error occurred (${key}).`;
}

// GET /user/settings
router.get('/', requireAuth, csrfProtection, async (req, res) => {
  try {
    const discordId = req.session.user!.discordId;
    const [dbUser, streamer] = await Promise.all([
      findUser(discordId),
      getStreamerByDiscordId(discordId),
    ]);

    const errorKey = KNOWN_ERRORS.has(req.query.error as string) ? (req.query.error as string) : null;
    const expectedAccount = (() => {
      if (errorKey !== 'eventsub_wrong_account') return undefined;
      const expected = req.query.expected as string | undefined;
      return expected && streamer?.twitch_name?.toLowerCase() === expected.toLowerCase() ? expected : undefined;
    })();

    // Strip decrypted OAuth tokens — the template only needs a boolean.
    const isConnected = !!(streamer?.eventsub_access_token);
    const safeStreamer = streamer
      ? { ...streamer, eventsub_access_token: null, eventsub_refresh_token: null }
      : null;

    res.render('userSettings', {
      user: req.session.user,
      dbUser,
      streamer: safeStreamer,
      isConnected,
      csrfToken: req.csrfToken(),
      error: errorKey,
      success: req.query.success as string | undefined,
      successExpectedAccount: expectedAccount,
      getFriendlyError,
    });
  } catch (err) {
    log.error('User settings page error:', err);
    res.status(500).render('error', { message: 'Failed to load settings page.', user: req.session.user ?? null });
  }
});

// GET /user/twitch-connect — initiates Twitch OAuth for the logged-in user
router.get('/twitch-connect', requireAuth, async (req, res) => {
  try {
    const discordId = req.session.user!.discordId;

    const [dbUser, streamer] = await Promise.all([
      findUser(discordId),
      getStreamerByDiscordId(discordId),
    ]);

    if (!streamer) return res.redirect('/user/settings?error=no_streamer_record');
    if (!dbUser?.is_twitch_bot_enabled) return res.redirect('/user/settings?error=eventsub_not_bot_enabled');

    if (!TWITCH_CLIENT_ID || !TWITCH_EVENTSUB_REDIRECT_URI || !EVENTSUB_TOKEN_SECRET) {
      log.error('TWITCH_CLIENT_ID, TWITCH_EVENTSUB_REDIRECT_URI, or EVENTSUB_TOKEN_SECRET is not configured');
      return res.redirect('/user/settings?error=eventsub_config_failed');
    }

    const state = randomBytes(16).toString('hex');
    req.session.eventsubOAuthState = state;
    req.session.eventsubStreamerId = streamer.id;

    const params = new URLSearchParams({
      client_id: TWITCH_CLIENT_ID,
      redirect_uri: TWITCH_EVENTSUB_REDIRECT_URI,
      response_type: 'code',
      scope: TWITCH_OAUTH_SCOPE,
      state,
      force_verify: 'true',
    });

    res.redirect(`https://id.twitch.tv/oauth2/authorize?${params.toString()}`);
  } catch (err) {
    log.error('Twitch connect error:', err);
    res.redirect('/user/settings?error=eventsub_config_failed');
  }
});

// POST /user/twitch-disconnect
router.post('/twitch-disconnect', requireAuth, csrfProtection, async (req, res) => {
  try {
    const discordId = req.session.user!.discordId;
    const streamer = await getStreamerByDiscordId(discordId);
    if (!streamer) return res.redirect('/user/settings?error=no_streamer_record');

    await clearStreamerToken(streamer.id);
    reloadEventSubSubscriptions();
    res.redirect('/user/settings');
  } catch (err) {
    log.error('EventSub disconnect error:', err);
    res.redirect('/user/settings?error=eventsub_disconnect_failed');
  }
});

// POST /user/eventsub-config
router.post('/eventsub-config', requireAuth, csrfProtection, async (req, res) => {
  try {
    const discordId = req.session.user!.discordId;

    const [dbUser, streamer] = await Promise.all([
      findUser(discordId),
      getStreamerByDiscordId(discordId),
    ]);

    if (!streamer) return res.redirect('/user/settings?error=no_streamer_record');
    if (!dbUser?.is_twitch_bot_enabled) return res.redirect('/user/settings?error=eventsub_not_bot_enabled');

    const body = req.body as Record<string, string | undefined>;

    const MESSAGE_MAX_LENGTH = 500;
    const messageFields = ['follow_message', 'sub_message', 'resub_message', 'giftsub_message', 'raid_message'] as const;
    for (const field of messageFields) {
      if ((body[field] ?? '').trim().length > MESSAGE_MAX_LENGTH) {
        return res.redirect('/user/settings?error=eventsub_config_failed');
      }
    }

    // Inputs are disabled in the UI when disconnected, so those keys are absent from
    // the POST body. Fall back to existing config to avoid wiping saved settings.
    const current = streamer.config;
    function bodyMsg(key: string, fallback: string): string {
      return key in body ? ((body[key] ?? '').trim() || fallback) : (current?.[key as keyof EventSubConfig] as string | undefined ?? fallback);
    }
    const config: EventSubConfig = {
      follow_enabled:  'follow_enabled'  in body ? body.follow_enabled  === 'on' : (current?.follow_enabled  ?? false),
      follow_message:  bodyMsg('follow_message',  'Thanks {display_name} for the follow!'),
      sub_enabled:     'sub_enabled'     in body ? body.sub_enabled     === 'on' : (current?.sub_enabled     ?? false),
      sub_message:     bodyMsg('sub_message',     'Thanks {display_name} for subscribing! (Tier {tier})'),
      resub_message:   bodyMsg('resub_message',   'Thanks {display_name} for {months} months! (Tier {tier})'),
      giftsub_message: bodyMsg('giftsub_message', '{gifter_display} gifted {count} sub(s) to the community!'),
      raid_enabled:    'raid_enabled' in body ? body.raid_enabled === 'on' : (current?.raid_enabled ?? false),
      raid_message:    bodyMsg('raid_message',    'Welcome raiders from {from_display}! Thank you for the {viewers} person raid!'),
    };

    await saveEventConfig(streamer.id, config);
    reloadEventSubSubscriptions();
    res.redirect('/user/settings');
  } catch (err) {
    log.error('EventSub config save error:', err);
    res.redirect('/user/settings?error=eventsub_config_failed');
  }
});

export default router;
