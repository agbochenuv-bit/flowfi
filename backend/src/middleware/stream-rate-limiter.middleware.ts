import { createRateLimiter } from './rate-limiter.middleware.js';
import { type Request, type Response, type NextFunction } from 'express';
import type { AuthenticatedRequest } from '../types/auth.types.js';
import logger from '../logger.js';
import { resolvePrincipalKey } from './principal-key.js';

/**
 * Create a per-wallet rate limiter middleware for stream creation
 * Uses the authenticated wallet address as the rate limit key
 * 
 * @param options Configuration options
 * @param options.windowMs Time window in milliseconds (default: 1 minute)
 * @param options.max Maximum requests per window (default: 10, configurable via STREAM_CREATE_RATE_LIMIT)
 * @returns Express rate limit middleware
 */
export function createStreamRateLimiter(
  options?: {
    windowMs?: number;
    max?: number;
  }
) {
  const windowMs = options?.windowMs ?? 60 * 1000; // 1 minute
  // Read from environment variable, default to 10 if not set
  const max = options?.max ?? (process.env.STREAM_CREATE_RATE_LIMIT ? parseInt(process.env.STREAM_CREATE_RATE_LIMIT, 10) : 10);

  return createRateLimiter({
    windowMs,
    max,
    message: {
      error: 'Too many stream creation requests - rate limit exceeded',
      message: 'You have exceeded the rate limit for stream creation. Please try again later.',
      status: 429,
    },
    /**
     * KeyGenerator: Use the shared principal-aware key resolver.
     * Authenticated callers are keyed by wallet address; anonymous callers
     * fall back to the trusted client IP (proxy-aware, see principal-key).
     */
    keyGenerator: (req: Request): string => {
      return resolvePrincipalKey(req, 'stream-create');
    },
    /**
     * Anonymous callers are now rate limited too (by IP) instead of being
     * skipped entirely, so unauthenticated abuse cannot bypass the budget.
     */
    skip: (req: Request, res: Response): boolean => {
      const authReq = req as AuthenticatedRequest;
      if (!authReq.user?.publicKey) {
        logger.debug('Stream creation rate limiter using anonymous IP-based key');
      }
      return false;
    },
    handler: (req: Request, res: Response, next: NextFunction, options: any): void => {
      const authReq = req as AuthenticatedRequest;
      logger.warn(
        `Rate limit exceeded for wallet: ${authReq.user?.publicKey || 'unknown'}`,
        { endpoint: req.path, method: req.method }
      );
      res.status(options.statusCode).json(options.message);
    },
  });
}

/**
 * Pre-configured rate limiter for stream creation endpoint
 * Default: 10 requests per minute per wallet (override via STREAM_CREATE_RATE_LIMIT)
 */
export const streamCreationRateLimiter = createStreamRateLimiter({
  windowMs: 60 * 1000, // 1 minute
});

/**
 * Per-route budgets for expensive stream operations.
 * Each budget is expressed as requests per minute and can be overridden
 * via environment variables without changing route paths or success shapes.
 */
export const STREAM_ROUTE_BUDGETS = {
  create: {
    windowMs: 60 * 1000,
    max: process.env.STREAM_CREATE_RATE_LIMIT
      ? parseInt(process.env.STREAM_CREATE_RATE_LIMIT, 10)
      : 10,
  },
  cancel: {
    windowMs: 60 * 1000,
    max: process.env.STREAM_CANCEL_RATE_LIMIT
      ? parseInt(process.env.STREAM_CANCEL_RATE_LIMIT, 10)
      : 20,
  },
  withdraw: {
    windowMs: 60 * 1000,
    max: process.env.STREAM_WITHDRAW_RATE_LIMIT
      ? parseInt(process.env.STREAM_WITHDRAW_RATE_LIMIT, 10)
      : 10,
  },
  simulate: {
    windowMs: 60 * 1000,
    max: process.env.STREAM_SIMULATE_RATE_LIMIT
      ? parseInt(process.env.STREAM_SIMULATE_RATE_LIMIT, 10)
      : 30,
  },
} as const;

export type StreamRouteBudget = keyof typeof STREAM_ROUTE_BUDGETS;

/**
 * Create a principal-aware limiter for a specific expensive stream route.
 * Uses the shared key resolver and the standard 429 envelope.
 */
export function createStreamRouteRateLimiter(route: StreamRouteBudget) {
  const budget = STREAM_ROUTE_BUDGETS[route];

  return createRateLimiter({
    windowMs: budget.windowMs,
    max: budget.max,
    message: {
      error: 'Too many requests - rate limit exceeded',
      message: `You have exceeded the rate limit for stream ${route}. Please try again later.`,
      status: 429,
    },
    keyGenerator: (req: Request): string => resolvePrincipalKey(req, `stream-${route}`),
    handler: (req: Request, res: Response, next: NextFunction, options: any): void => {
      const authReq = req as AuthenticatedRequest;
      logger.warn(
        `Rate limit exceeded for stream ${route} (principal: ${authReq.user?.publicKey || 'anonymous'})`,
        { endpoint: req.path, method: req.method }
      );
      res.status(options.statusCode).json(options.message);
    },
  });
}

/** Pre-configured per-route limiters for expensive stream operations. */
export const streamCancelRateLimiter = createStreamRouteRateLimiter('cancel');
export const streamWithdrawRateLimiter = createStreamRouteRateLimiter('withdraw');
export const streamSimulateRateLimiter = createStreamRouteRateLimiter('simulate');
