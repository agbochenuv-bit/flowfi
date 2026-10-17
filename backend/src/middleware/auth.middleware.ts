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
 */
export const authMiddleware = requireAuth;

/**
 * Optional authentication middleware
 *
 * Uses the same JWT validation as authMiddleware but does not fail when
 * no token is provided.
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

/**
 * Error thrown when a wallet attempts to access a resource it does not own.
 */
export class WalletScopeError extends Error {
  public readonly statusCode: number;

  constructor(message = 'Wallet is not authorized to access this resource', statusCode = 403) {
    super(message);
    this.name = 'WalletScopeError';
    this.statusCode = statusCode;
  }
}

/**
 * Minimal shape of a stream record needed for ownership checks.
 */
export interface StreamOwnershipRecord {
  id: string;
  sender?: string | null;
  recipient?: string | null;
  owner?: string | null;
}

/**
 * Minimal stream repository interface used by the authorization helpers.
 *
 * Implementations are expected to look up a stream by its identifier and
 * return `null` when it does not exist.
 */
export interface StreamRepository {
  findById(id: string): Promise<StreamOwnershipRecord | null> | StreamOwnershipRecord | null;
}

/**
 * Resolve the authenticated wallet public key from a request.
 *
 * Returns `null` when the request has not been authenticated.
 */
export function getAuthenticatedWallet(req: Request): string | null {
  const user = (req as AuthenticatedRequest).user;
  return user?.publicKey ?? null;
}

/**
 * Assert that the authenticated wallet owns the given stream.
 *
 * Ownership is granted when the wallet matches the stream's owner, sender,
 * or recipient. Throws a {@link WalletScopeError} when the request is
 * unauthenticated, the stream does not exist, or the wallet does not own it.
 *
 * @param req - The incoming request (must be authenticated).
 * @param streamId - The identifier of the stream to check.
 * @param repository - The stream repository used to look up the stream.
 * @returns The resolved stream record when ownership is confirmed.
 */
export async function assertWalletOwnsStream(
  req: Request,
  streamId: string,
  repository: StreamRepository
): Promise<StreamOwnershipRecord> {
  const wallet = getAuthenticatedWallet(req);

  if (!wallet) {
    throw new WalletScopeError('Authentication required', 401);
  }

  if (!streamId || typeof streamId !== 'string') {
    throw new WalletScopeError('Invalid stream identifier', 400);
  }

  const stream = await repository.findById(streamId);

  if (!stream) {
    throw new WalletScopeError('Stream not found', 404);
  }

  const owners = [stream.owner, stream.sender, stream.recipient].filter(
    (value): value is string => typeof value === 'string' && value.length > 0
  );

  if (!owners.includes(wallet)) {
    throw new WalletScopeError();
  }

  return stream;
}

/**
 * Express middleware factory that enforces wallet ownership of a stream.
 *
 * The stream identifier is read from `req.params[paramName]` (defaults to
 * `id`). On success the resolved stream is attached to `res.locals.stream`
 * and the request proceeds. On failure the middleware responds with the
 * appropriate status code (401, 400, 403, or 404).
 *
 * @param repository - The stream repository used to look up the stream.
 * @param paramName - The route parameter containing the stream id.
 */
export function requireWalletScope(
  repository: StreamRepository,
  paramName = 'id'
) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const streamId = (req.params as Record<string, string | undefined>)[paramName];

      if (!streamId) {
        res.status(400).json({ error: 'Missing stream identifier' });
        return;
      }

      const stream = await assertWalletOwnsStream(req, streamId, repository);
      res.locals.stream = stream;
      next();
    } catch (error) {
      if (error instanceof WalletScopeError) {
        res.status(error.statusCode).json({ error: error.message });
        return;
      }
      next(error);
    }
  };
}