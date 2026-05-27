import { Router, type IRouter } from 'express';
import { getJwks } from '../modules/token/token.service';

export const jwksRouter: IRouter = Router();

/**
 * GET /.well-known/jwks.json
 * Public key set for consumer JWT verification.
 */
jwksRouter.get('/.well-known/jwks.json', async (_req, res, next) => {
  try {
    const jwks = await getJwks();
    res.json(jwks);
  } catch (err) {
    next(err);
  }
});
