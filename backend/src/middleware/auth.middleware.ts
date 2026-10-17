import type { Request, Response, NextFunction } from 'express';
import { requireAuth, verifyJwt } from './auth.js';
import type { AuthenticatedRequest } from '../types/auth.types.js';

/**
 * Extract Bearer token from Authorization header
 */
function extractBearerToken(req: Request): string | null {
  const authHeader = req.headers.authorization;

  if (!authHeader) {
    return null;
  }

  const parts = authHeader.split(' ');
  if (parts.length !== 2 || parts[0] !== 'Bearer') {
    return null;
  }

  return parts[1] ?? null;
}

/**
 * Authentication middleware alias
 *
 * Uses JWT authentication via the standard challenge/verify flow.
 * Verification is kid-aware: tokens are validated against the active
 * verification-key set (active overlap keys plus any still-valid keys),
 * and tokens signed by retired or unknown keys are rejected.
 */
export const authMiddleware = requireAuth;

/**
 * Optional authentication middleware
 *
 * Uses the same kid-aware JWT validation as authMiddleware but does not
 * fail when no token is provided. Tokens signed by retired or unknown
 * keys are treated as unauthenticated (no user is attached) rather than
 * producing an error, and no secret material or raw key values are ever
 * surfaced in diagnostics.
 */
export const optionalAuthMiddleware = (
  req: Request,
  _res: Response,
  next: NextFunction
): void => {
  const token = extractBearerToken(req);

  if (token) {
    const payload = verifyJwt(token);
    if (payload) {
      (req as AuthenticatedRequest).user = { publicKey: payload.publicKey };
    }
  }

  next();
};