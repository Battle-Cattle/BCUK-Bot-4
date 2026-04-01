import { Router } from 'express';
import crypto from 'crypto';
import { DISCORD_CLIENT_ID, DISCORD_CLIENT_SECRET, DISCORD_CALLBACK_URL } from '../../config';
import { findUser, updateDiscordName } from '../../db';
import { fetchMemberDisplayName } from '../../discordBot';

const router = Router();

// ─── Redirect to Discord OAuth2 ─────────────────────────────────────────────
router.get('/discord', (req, res) => {
  const state = crypto.randomBytes(16).toString('hex');
  req.session.oauthState = state;

  const params = new URLSearchParams({
    client_id: DISCORD_CLIENT_ID,
    redirect_uri: DISCORD_CALLBACK_URL,
    response_type: 'code',
    scope: 'identify',
    state,
  });
  const authUrl = `https://discord.com/oauth2/authorize?${params}`;
  res.redirect(authUrl);
});

// ─── OAuth2 callback ─────────────────────────────────────────────────────────
router.get('/discord/callback', async (req, res) => {
  const { code, state } = req.query as { code?: string; state?: string };

  if (!code || !state || state !== req.session.oauthState) {
    return res.status(400).render('error', {
      message: 'Invalid OAuth2 state — please try logging in again.',
      user: null,
    });
  }
  delete req.session.oauthState;

  try {
    // 1. Exchange code for access token
    const tokenRes = await fetch('https://discord.com/api/oauth2/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: DISCORD_CLIENT_ID,
        client_secret: DISCORD_CLIENT_SECRET,
        grant_type: 'authorization_code',
        code,
        redirect_uri: DISCORD_CALLBACK_URL,
      }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!tokenRes.ok) throw new Error(`Token exchange failed: ${tokenRes.status}`);
    const { access_token } = (await tokenRes.json()) as { access_token: string };

    // 2. Fetch Discord user profile
    const profileRes = await fetch('https://discord.com/api/users/@me', {
      headers: { Authorization: `Bearer ${access_token}` },
      signal: AbortSignal.timeout(10_000),
    });
    if (!profileRes.ok) throw new Error(`Profile fetch failed: ${profileRes.status}`);
    const profile = (await profileRes.json()) as {
      id: string;
      username: string;
      avatar: string | null;
    };

    // 3. Check the user table whitelist
    const dbUser = await findUser(profile.id);
    if (!dbUser) {
      return res.status(403).render('error', {
        message: 'You are not on the whitelist. Contact an admin to be added.',
        user: null,
      });
    }

    let syncedDiscordName = profile.username;
    try {
      const displayName = await fetchMemberDisplayName(profile.id);
      if (displayName && displayName.trim()) {
        syncedDiscordName = displayName.trim();
        await updateDiscordName(profile.id, syncedDiscordName);
      }
    } catch (syncErr) {
      console.warn('[Web] Non-blocking discord_name sync failed:', syncErr);
    }

    // 4. Save to session
    req.session.user = {
      discordId: profile.id,
      discordName: syncedDiscordName,
      discordAvatar: profile.avatar
        ? `https://cdn.discordapp.com/avatars/${profile.id}/${profile.avatar}.png`
        : null,
      accessLevel: dbUser.access_level as 0 | 1 | 2 | 3,
    };

    res.redirect('/');
  } catch (err) {
    console.error('[Web] Auth error:', err);
    res.status(500).render('error', {
      message: 'Authentication failed — please try again.',
      user: null,
    });
  }
});

// ─── Logout ───────────────────────────────────────────────────────────────────
router.get('/logout', (req, res) => {
  req.session.destroy(() => res.redirect('/auth/login'));
});

// ─── Login page ───────────────────────────────────────────────────────────────
router.get('/login', (req, res) => {
  if (req.session.user) return res.redirect('/');
  res.render('login', { user: null });
});

export default router;
