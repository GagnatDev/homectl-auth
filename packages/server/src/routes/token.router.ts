/**
 * POST /token — authorization code exchange (server-to-server, client-authenticated).
 */

import { Router, type IRouter } from 'express';
import { exchangeCode } from '../modules/auth-code/auth-code.service';

export const tokenRouter: IRouter = Router();

tokenRouter.post('/token', async (req, res) => {
  const { grant_type, code, client_id, client_secret, redirect_uri } = req.body as Record<
    string,
    string
  >;

  if (grant_type !== 'authorization_code') {
    res.status(400).json({ error: 'unsupported_grant_type' });
    return;
  }

  if (!code || !client_id || !client_secret || !redirect_uri) {
    res.status(400).json({ error: 'invalid_request', error_description: 'Missing required fields' });
    return;
  }

  const outcome = await exchangeCode({ code, clientId: client_id, clientSecret: client_secret, redirectUri: redirect_uri });

  if (!outcome.ok) {
    switch (outcome.error) {
      case 'INVALID_CLIENT':
        res.status(401).json({ error: 'invalid_client' });
        return;
      case 'INVALID_CODE':
        res.status(400).json({ error: 'invalid_grant', error_description: 'Invalid authorization code' });
        return;
      case 'EXPIRED_CODE':
        res.status(400).json({ error: 'invalid_grant', error_description: 'Authorization code expired' });
        return;
      case 'REDIRECT_URI_MISMATCH':
        res.status(400).json({ error: 'invalid_grant', error_description: 'redirect_uri mismatch' });
        return;
      case 'CLIENT_ID_MISMATCH':
        res.status(400).json({ error: 'invalid_grant', error_description: 'client_id mismatch' });
        return;
    }
  }

  res.json({
    access_token: outcome.result.accessToken,
    token_type: outcome.result.tokenType,
    expires_in: outcome.result.expiresIn,
  });
});
