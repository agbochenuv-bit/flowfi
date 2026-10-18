import { rateLimit } from 'express-rate-limit';
import type { Request, Response } from 'express';
import {
  resolvePrincipalKey,
  createPrincipalRateLimitStore,
  buildRateLimit429Response,
  isRateLimitingEnabled,
} from './principal-rate-limit.util';

export const adminRateLimiter = rateLimit({
  windowMs: 1 * 60 * 1000, // 1 minute
  max: 30, // Stricter limit: 30 requests per minute for admin endpoints
  standardHeaders: true,
  legacyHeaders: false,
  message: buildRateLimit429Response('admin'),
  // Principal-aware key: authenticated admin subject when present, otherwise a
  // trusted-proxy-aware client IP. Direct x-forwarded-for trust is removed; the
  // resolver only honors forwarding headers from configured trusted proxies.
  keyGenerator: (req: Request): string => resolvePrincipalKey(req, 'admin'),
  // Redis-backed store with in-memory fallback when Redis is unavailable.
  store: createPrincipalRateLimitStore('admin'),
  // Gate via configuration instead of NODE_ENV so behavior is observable and
  // controllable in all environments (including tests).
  skip: (): boolean => !isRateLimitingEnabled('admin'),
  handler: (req: Request, res: Response, _next, options): void => {
    res.status(options.statusCode).json(options.message);
  },
});