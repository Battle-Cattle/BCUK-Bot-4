import crypto from 'crypto';
import { Router } from 'express';
import {
  getAllStreamGroups,
  addStreamGroup,
  updateStreamGroup,
  removeStreamGroup,
  getAllStreamers,
  addStreamer,
  removeStreamer,
  removeStreamersByGroup,
} from '../../db';
import { requireManager, requireAdmin } from '../middleware';
import { getMonitorEnabled, setMonitorEnabled, getEventSubToken, setEventSubToken } from '../../monitorSettings';
import { restartTwitchMonitor, getLiveStates, catchUpDiscordPosts } from '../../twitchMonitor';
import { TWITCH_CLIENT_ID, TWITCH_CLIENT_SECRET, TWITCH_EVENTSUB_REDIRECT_URL } from '../../config';

const router = Router();

// ─── View ─────────────────────────────────────────────────────────────────────

router.get('/streams', requireManager, async (req, res) => {
  try {
    const [groups, streamers] = await Promise.all([getAllStreamGroups(), getAllStreamers()]);
    res.render('streams', {
      user: req.session.user,
      groups,
      streamers,
      monitorEnabled: getMonitorEnabled(),
      twitchTokenSaved: !!getEventSubToken(),
      twitchAuthConfigured: !!TWITCH_EVENTSUB_REDIRECT_URL,
    });
  } catch (err) {
    console.error('[Web] Streams page error:', err);
    res.status(500).render('error', { message: 'Failed to load streams page.', user: req.session.user ?? null });
  }
});

// ─── Toggle ───────────────────────────────────────────────────────────────────

router.post('/streams/toggle', requireManager, (req, res) => {
  const wasEnabled = getMonitorEnabled();
  setMonitorEnabled(!wasEnabled);

  if (!wasEnabled) {
    // Turning ON — post announcements for any currently tracked live streams
    catchUpDiscordPosts().catch((err) =>
      console.error('[Web] TwitchMonitor catch-up error:', err),
    );
  }
  // Turning OFF — nothing to do; monitor keeps running, Discord posts are silenced

  res.redirect('/admin/streams');
});

// ─── Twitch OAuth (EventSub token) ───────────────────────────────────────────

router.get('/streams/twitch-auth', requireAdmin, (req, res) => {
  if (!TWITCH_EVENTSUB_REDIRECT_URL) {
    return res.status(400).render('error', {
      message: 'TWITCH_EVENTSUB_REDIRECT_URL is not set in .env. Add it and restart the bot.',
      user: req.session.user ?? null,
    });
  }
  const state = crypto.randomBytes(16).toString('hex');
  req.session.oauthState = state;
  const params = new URLSearchParams({
    client_id: TWITCH_CLIENT_ID,
    redirect_uri: TWITCH_EVENTSUB_REDIRECT_URL,
    response_type: 'code',
    scope: '',
    state,
  });
  res.redirect(`https://id.twitch.tv/oauth2/authorize?${params}`);
});

router.get('/streams/twitch-auth/callback', requireAdmin, async (req, res) => {
  const { code, state } = req.query as { code?: string; state?: string };
  if (!code || !state || state !== req.session.oauthState) {
    return res.status(400).render('error', {
      message: 'Invalid OAuth state — please try the Twitch authorisation again.',
      user: req.session.user ?? null,
    });
  }
  delete req.session.oauthState;

  if (!TWITCH_EVENTSUB_REDIRECT_URL) {
    return res.status(400).render('error', { message: 'TWITCH_EVENTSUB_REDIRECT_URL is not configured.', user: req.session.user ?? null });
  }

  try {
    const tokenRes = await fetch('https://id.twitch.tv/oauth2/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: TWITCH_CLIENT_ID,
        client_secret: TWITCH_CLIENT_SECRET,
        grant_type: 'authorization_code',
        code,
        redirect_uri: TWITCH_EVENTSUB_REDIRECT_URL,
      }).toString(),
    });
    if (!tokenRes.ok) throw new Error(`Token exchange failed: ${tokenRes.status}`);
    const data = await tokenRes.json() as { access_token: string };
    setEventSubToken(data.access_token);
    // Restart monitor so it picks up the new token immediately
    triggerRestart();
    console.log('[Web] Twitch EventSub token saved and monitor restarted');
    res.redirect('/admin/streams');
  } catch (err) {
    console.error('[Web] Twitch auth callback error:', err);
    res.status(500).render('error', { message: 'Twitch token exchange failed. Please try again.', user: req.session.user ?? null });
  }
});

// ─── Live state snapshot ──────────────────────────────────────────────────────

router.get('/streams/live', requireManager, (_req, res) => {
  res.json({ enabled: getMonitorEnabled(), streams: getLiveStates() });
});

// ─── Groups ───────────────────────────────────────────────────────────────────

router.post('/streams/groups/add', requireManager, async (req, res) => {
  const { name, discord_channel, live_message, new_game_message, multi_twitch_message } = req.body as Record<string, string | undefined>;
  const multi_twitch = req.body.multi_twitch === 'on';
  const delete_old_posts = req.body.delete_old_posts === 'on';

  if (!name || !discord_channel || !live_message || !new_game_message) {
    return res.redirect('/admin/streams');
  }

  try {
    await addStreamGroup(
      name.trim(),
      discord_channel.trim(),
      live_message.trim(),
      new_game_message.trim(),
      multi_twitch,
      (multi_twitch_message ?? '').trim(),
      delete_old_posts,
    );
    triggerRestart();
  } catch (err) {
    console.error('[Web] Add stream group error:', err);
  }
  res.redirect('/admin/streams');
});

router.post('/streams/groups/update', requireManager, async (req, res) => {
  const { group_id, name, discord_channel, live_message, new_game_message, multi_twitch_message } = req.body as Record<string, string | undefined>;
  const multi_twitch = req.body.multi_twitch === 'on';
  const delete_old_posts = req.body.delete_old_posts === 'on';

  if (!group_id || !name || !discord_channel || !live_message || !new_game_message) {
    return res.redirect('/admin/streams');
  }

  try {
    await updateStreamGroup(
      parseInt(group_id, 10),
      name.trim(),
      discord_channel.trim(),
      live_message.trim(),
      new_game_message.trim(),
      multi_twitch,
      (multi_twitch_message ?? '').trim(),
      delete_old_posts,
    );
    triggerRestart();
  } catch (err) {
    console.error('[Web] Update stream group error:', err);
  }
  res.redirect('/admin/streams');
});

router.post('/streams/groups/remove', requireManager, async (req, res) => {
  const { group_id } = req.body as { group_id?: string };
  if (!group_id) return res.redirect('/admin/streams');

  try {
    // Delete streamers in the group first (avoids FK constraint errors)
    await removeStreamersByGroup(parseInt(group_id, 10));
    await removeStreamGroup(parseInt(group_id, 10));
    triggerRestart();
  } catch (err) {
    console.error('[Web] Remove stream group error:', err);
  }
  res.redirect('/admin/streams');
});

// ─── Streamers ────────────────────────────────────────────────────────────────

router.post('/streams/streamers/add', requireManager, async (req, res) => {
  const { name, group_id } = req.body as { name?: string; group_id?: string };
  if (!name || !group_id) return res.redirect('/admin/streams');

  try {
    await addStreamer(name.trim(), parseInt(group_id, 10));
    triggerRestart();
  } catch (err) {
    console.error('[Web] Add streamer error:', err);
  }
  res.redirect('/admin/streams');
});

router.post('/streams/streamers/remove', requireManager, async (req, res) => {
  const { streamer_id } = req.body as { streamer_id?: string };
  if (!streamer_id) return res.redirect('/admin/streams');

  try {
    await removeStreamer(parseInt(streamer_id, 10));
    triggerRestart();
  } catch (err) {
    console.error('[Web] Remove streamer error:', err);
  }
  res.redirect('/admin/streams');
});

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Fire-and-forget monitor restart; always runs so in-memory state stays current. */
function triggerRestart(): void {
  restartTwitchMonitor().catch((err) =>
    console.error('[Web] TwitchMonitor restart error:', err),
  );
}

export default router;
