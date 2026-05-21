import { createLogger } from '../../logger';
import { Router } from 'express';
import { randomBytes } from 'crypto';
import {
  getAllEventSubStreamers,
  saveEventConfig,
  clearStreamerToken,
  getTwitchEnabledChannels,
  EventSubConfig,
} from '../../db';
import { csrfProtection } from '../csrf';
import { requireAdmin } from '../middleware';
import { reloadEventSubSubscriptions } from '../../twitchEventSub';
import { TWITCH_CLIENT_ID, TWITCH_EVENTSUB_REDIRECT_URI } from '../../config';
import { parsePositiveIntId } from './shared';

const log = createLogger('Web');
const router = Router();

const TWITCH_OAUTH_SCOPE = 'moderator:read:followers channel:read:subscriptions';

router.get('/streams/twitch-oauth/:streamerId', requireAdmin, async (req, res) => {
  const streamerId = parsePositiveIntId(req.params['streamerId']);
  if (streamerId === null) return res.redirect('/admin/streams?error=invalid_id');

  const streamers = await getAllEventSubStreamers().catch(() => null);
  const streamer = streamers?.find((s) => s.id === streamerId);
  if (!streamer) return res.redirect('/admin/streams?error=invalid_id');

  const botEnabled = await getTwitchEnabledChannels().catch(() => [] as string[]);
  if (!botEnabled.includes(streamer.name)) {
    return res.redirect('/admin/streams?error=eventsub_not_bot_enabled');
  }

  const state = randomBytes(16).toString('hex');
  req.session.eventsubOAuthState = state;
  req.session.eventsubStreamerId = streamerId;

  const params = new URLSearchParams({
    client_id: TWITCH_CLIENT_ID,
    redirect_uri: TWITCH_EVENTSUB_REDIRECT_URI,
    response_type: 'code',
    scope: TWITCH_OAUTH_SCOPE,
    state,
    force_verify: 'true',
  });

  res.redirect(`https://id.twitch.tv/oauth2/authorize?${params.toString()}`);
});

router.post('/streams/twitch-disconnect/:streamerId', requireAdmin, csrfProtection, async (req, res) => {
  const streamerId = parsePositiveIntId(req.params.streamerId);
  if (streamerId === null) return res.redirect('/admin/streams?error=invalid_id');

  try {
    await clearStreamerToken(streamerId);
    reloadEventSubSubscriptions();
  } catch (err) {
    log.error('EventSub disconnect error:', err);
    return res.redirect('/admin/streams?error=eventsub_disconnect_failed');
  }
  res.redirect('/admin/streams');
});

router.post('/streams/event-config/:streamerId', requireAdmin, csrfProtection, async (req, res) => {
  const streamerId = parsePositiveIntId(req.params.streamerId);
  if (streamerId === null) return res.redirect('/admin/streams?error=invalid_id');

  const botEnabled = await getTwitchEnabledChannels().catch(() => [] as string[]);
  const streamers = await getAllEventSubStreamers().catch(() => null);
  const streamer = streamers?.find((s) => s.id === streamerId);
  if (!streamer || !botEnabled.includes(streamer.name)) {
    return res.redirect('/admin/streams?error=eventsub_not_bot_enabled');
  }

  const body = req.body as Record<string, string | undefined>;

  const MESSAGE_MAX_LENGTH = 500;
  const messageFields = ['follow_message', 'sub_message', 'resub_message', 'giftsub_message', 'raid_message'] as const;
  for (const field of messageFields) {
    const value = (body[field] ?? '').trim();
    if (value.length > MESSAGE_MAX_LENGTH) {
      return res.redirect('/admin/streams?error=eventsub_config_failed');
    }
  }

  const config: EventSubConfig = {
    follow_enabled: body.follow_enabled === 'on',
    follow_message: (body.follow_message ?? '').trim() || 'Thanks {display_name} for the follow!',
    sub_enabled: body.sub_enabled === 'on',
    sub_message: (body.sub_message ?? '').trim() || 'Thanks {display_name} for subscribing! (Tier {tier_name})',
    resub_message: (body.resub_message ?? '').trim() || 'Thanks {display_name} for {months} months! (Tier {tier_name})',
    giftsub_message: (body.giftsub_message ?? '').trim() || '{gifter_display} gifted {count} sub(s) to the community!',
    raid_enabled: body.raid_enabled === 'on',
    raid_message: (body.raid_message ?? '').trim() || 'Welcome raiders from {from_channel}! Thank you for the {viewers} person raid!',
  };

  try {
    await saveEventConfig(streamerId, config);
    reloadEventSubSubscriptions();
  } catch (err) {
    log.error('EventSub config save error:', err);
    return res.redirect('/admin/streams?error=eventsub_config_failed');
  }

  res.redirect('/admin/streams');
});

export default router;
