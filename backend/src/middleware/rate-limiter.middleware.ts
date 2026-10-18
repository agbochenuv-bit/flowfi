import { rateLimit, type Options } from 'express-rate-limit';

/**
 * Shared factory to create an express-rate-limit instance with common configuration.
 * 
 * @param options Configuration options for express-rate-limit
 * @returns Express rate limit middleware
 */
export function createRateLimiter(options: Partial<Options>) {
  return rateLimit({
    standardHeaders: true, // Return rate limit info in the `RateLimit-*` headers
    legacyHeaders: false, // Disable the `X-RateLimit-*` headers
    ...options,
  });
}

export const globalRateLimiter = createRateLimiter({
  windowMs: 1 * 60 * 1000, // 1 minute
  max: 100, // Limit each IP to 100 requests per `window` (here, per minute)
  standardHeaders: true, // Return rate limit info in the `RateLimit-*` headers
  legacyHeaders: false, // Disable the `X-RateLimit-*` headers
  // The Prometheus scrape endpoint must never be throttled: a 429 would make
  // Prometheus mark the target down and blind the whole alerting pipeline.
  // It is protected by its own network/token guard instead.
  skip: (req) => req.path === '/metrics' || req.path.startsWith('/metrics/'),
  message: {
    message: 'Too many requests, please try again later.',
    status: 429,
  },
});
/**
 * Dedicated limiter for `/health` (issue #1511).
 *
 * Liveness probes hit this endpoint at a fixed cadence and must always pass —
 * but unbounded external scanners can flood it and saturate the DB pool with
 * the `SELECT 1` the handler runs on every request. 60 requests per minute per
 * IP is comfortably above any realistic probe, but low enough to stop a
 * scraper from amplifying a single connection into hundreds of DB hits/second.
 */
export const healthRateLimiter = createRateLimiter({
  windowMs: 60 * 1000,
  max: 60,
  message: {
    message: 'Too many health check requests, please try again later.',
    status: 429,
  },
});

/**
 * Dedicated limiter for webhook delivery replay (issue #59).
 *
 * Replaying failed deliveries fans out outbound HTTP requests to subscriber
 * endpoints, so it is far more expensive than a normal read. Replays are
 * scoped per IP *and* per authenticated wallet address so that a single
 * caller cannot exhaust the budget for other users behind the same NAT/proxy,
 * while still bounding the total fan-out a single IP can trigger.
 *
 * 5 replays per 10 minutes is enough for normal operational retries but low
 * enough to prevent an attacker from using the replay endpoint as an
 * outbound request amplifier.
 */
export const webhookReplayRateLimiter = createRateLimiter({
  windowMs: 10 * 60 * 1000, // 10 minutes
  max: 5, // 5 replay requests per window per IP + user address
  keyGenerator: (req) => {
    const userAddress =
      (req as { user?: { address?: string } }).user?.address ?? 'anonymous';
    return `${req.ip}:${userAddress.toLowerCase()}`;
  },
  message: {
    message: 'Too many webhook replay requests, please try again later.',
    status: 429,
  },
});
