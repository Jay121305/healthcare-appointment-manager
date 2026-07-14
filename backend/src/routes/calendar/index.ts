// backend/src/routes/calendar/index.ts
// Google Calendar OAuth routes — connect / callback / disconnect / status.
// Patient and Doctor roles can connect; Admin cannot (admins have no appointments).
// The callback route is public because Google does a top-level browser GET after consent;
// the authenticated user identity is reconstructed from a single-use state token in Redis.

import { Router, Request, Response } from 'express';
import { authenticate, requireRoles } from '../../middleware/auth';
import {
  generateAndStoreState,
  consumeState,
  buildAuthUrl,
  exchangeCodeAndStore,
  disconnect,
  getConnectionStatus,
} from '../../services/calendar/oauthService';

const router = Router();

// ─────────────────────────────────────────────────────────────────────────────
// GET /calendar/connect — start OAuth flow
// Auth: requires JWT. State token bound to the authenticated user is stored in Redis.
// ─────────────────────────────────────────────────────────────────────────────
router.get(
  '/connect',
  authenticate,
  requireRoles('PATIENT', 'DOCTOR'),
  async (req: Request, res: Response): Promise<void> => {
    try {
      const role = req.user.role as 'PATIENT' | 'DOCTOR' | 'ADMIN';
      if (role === 'ADMIN') {
        res.status(403).json({ error: 'FORBIDDEN' });
        return;
      }
      const state = await generateAndStoreState(req.user.id, role);
      const redirectUrl = buildAuthUrl(state);
      res.status(200).json({ redirectUrl });
    } catch (err) {
      console.error('[Calendar] connect error:', err);
      res.status(500).json({ error: 'INTERNAL_ERROR' });
    }
  }
);

// ─────────────────────────────────────────────────────────────────────────────
// GET /calendar/callback — OAuth callback (PUBLIC — no JWT)
// Identity comes from the `state` token; validated against Redis.
// ─────────────────────────────────────────────────────────────────────────────
router.get('/callback', async (req: Request, res: Response): Promise<void> => {
  try {
    const { code, state } = req.query;

    if (typeof code !== 'string' || typeof state !== 'string') {
      res.status(400).json({ error: 'CODE_AND_STATE_REQUIRED' });
      return;
    }

    const statePayload = await consumeState(state);
    if (!statePayload) {
      res.status(400).json({ error: 'INVALID_OR_EXPIRED_STATE' });
      return;
    }

    // Only PATIENT/DOCTOR may connect (state was minted by authenticated user)
    if (statePayload.role !== 'PATIENT' && statePayload.role !== 'DOCTOR') {
      res.status(403).json({ error: 'ROLE_NOT_PERMITTED' });
      return;
    }

    const result = await exchangeCodeAndStore(code, statePayload.userId);

    // Return a small HTML page that closes the tab (frontend can poll status).
    // If FRONTEND_OAUTH_RETURN_URL is set, redirect there after a short delay.
    const returnTo = process.env.FRONTEND_OAUTH_RETURN_URL;
    const redirectScript = returnTo
      ? `<script>setTimeout(function(){window.location.href=${JSON.stringify(returnTo)};}, 2000);</script>`
      : '';
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.status(200).send(`<!DOCTYPE html><html><head><meta charset="utf-8"><title>Calendar Connected</title>` +
      `<style>body{font-family:system-ui,sans-serif;padding:2rem;color:#333;text-align:center}</style></head>` +
      `<body><h2>Google Calendar connected</h2>` +
      `<p>You can close this tab and return to the portal${result.googleEmail ? ` (connected as ${result.googleEmail})` : ''}.</p>` +
      redirectScript +
      `</body></html>`);
  } catch (err) {
    const msg = (err as Error).message ?? String(err);
    console.error('[Calendar] callback error:', msg);
    // Surface the OAuth exchange failure to the user (Google may return invalid_grant etc.)
    const isExchangeError = msg.includes('OAUTH_EXCHANGE_FAILED') || msg.startsWith('invalid_grant');
    res
      .status(isExchangeError ? 400 : 500)
      .json({ error: isExchangeError ? 'OAUTH_EXCHANGE_FAILED' : 'INTERNAL_ERROR', message: msg });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /calendar/disconnect — revoke and remove the user's OAuth row
// Best-effort revoke at Google side; deletion happens regardless.
// ─────────────────────────────────────────────────────────────────────────────
router.post(
  '/disconnect',
  authenticate,
  requireRoles('PATIENT', 'DOCTOR'),
  async (req: Request, res: Response): Promise<void> => {
    try {
      const wasConnected = await disconnect(req.user.id);
      if (!wasConnected) {
        res.status(404).json({ error: 'NOT_CONNECTED', message: 'No Google Calendar connection to remove' });
        return;
      }
      res.status(200).json({ message: 'Google Calendar disconnected successfully' });
    } catch (err) {
      console.error('[Calendar] disconnect error:', err);
      res.status(500).json({ error: 'INTERNAL_ERROR' });
    }
  }
);

// ─────────────────────────────────────────────────────────────────────────────
// GET /calendar/status — query current connection state
// ─────────────────────────────────────────────────────────────────────────────
router.get(
  '/status',
  authenticate,
  requireRoles('PATIENT', 'DOCTOR'),
  async (req: Request, res: Response): Promise<void> => {
    try {
      const status = await getConnectionStatus(req.user.id);
      res.status(200).json(status);
    } catch (err) {
      console.error('[Calendar] status error:', err);
      res.status(500).json({ error: 'INTERNAL_ERROR' });
    }
  }
);

export default router;
