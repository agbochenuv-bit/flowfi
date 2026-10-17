import { rateLimit, type Options, type Store } from 'express-rate-limit';
import type { Request, Response } from 'express';

/**
 * Minimal structural view of the authenticated principal attached by the auth
 * middleware. Kept local so this module does not depend on the auth package.
 */
interface AuthenticatedRequest extends Request {
  user?: { publicKey?: string };
}

/**
 * Resolve the rate-limit key for a request.
 *
 * - Authenticated callers are keyed by their principal (`req.user.publicKey`)
 *   so a single account cannot multiply its budget by rotating IPs.
 * - Anonymous callers are keyed by client IP.
 * - `X-Forwarded-For` is only honoured when the immediate peer is a trusted
 *   proxy (see {@link isTrustedProxy}); otherwise a spoofed header would let a
 *   caller mint unlimited keys.
 */
export function resolveRateLimitKey(req: AuthenticatedRequest): string {
  const subject = req.user?.publicKey;
  if (typeof subject === 'string' && subject.length > 0) {
    return `principal:${subject}`;
  }
  return `ip:${resolveClientIp(req)}`;
}

/**
 * Parse the trusted-proxy allowlist from `TRUSTED_PROXIES` (comma separated
 * IPs/CIDRs). Empty or unset means no proxy is trusted.
 */
export function getTrustedProxies(): string[] {
  const raw = process.env.TRUSTED_PROXIES ?? '';
  return raw
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

function ipv4ToInt(ip: string): number | null {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  let value = 0;
  for (const part of parts) {
    const octet = Number(part);
    if (!Number.isInteger(octet) || octet < 0 || octet > 255) return null;
    value = value * 256 + octet;
  }
  return value;
}

function matchesCidr(ip: string, cidr: string): boolean {
  const [network, bitsRaw] = cidr.split('/');
  const bits = Number(bitsRaw);
  const ipInt = ipv4ToInt(ip);
  const netInt = ipv4ToInt(network);
  if (ipInt === null || netInt === null || !Number.isInteger(bits) || bits < 0 || bits > 32) {
    return false;
  }
  if (bits === 0) return true;
  const mask = bits === 32 ? 0xffffffff : (0xffffffff << (32 - bits)) >>> 0;
  return (ipInt & mask) === (netInt & mask);
}

/**
 * Whether the immediate peer of the connection is a configured trusted proxy.
 * Only then may forwarding headers be believed.
 */
export function isTrustedProxy(remoteAddress: string | undefined): boolean {
  if (!remoteAddress) return false;
  const proxies = getTrustedProxies();
  if (proxies.length === 0) return false;
  const normalized = remoteAddress.startsWith('::ffff:')
    ? remoteAddress.slice('::ffff:'.length)
    : remoteAddress;
  return proxies.some((proxy) =>
    proxy.includes('/') ? matchesCidr(normalized, proxy) : proxy === normalized,
  );
}

/**
 * Resolve the client IP, trusting `X-Forwarded-For` only behind a trusted proxy.
 */
export function resolveClientIp(req: Request): string {
  const peer = req.socket?.remoteAddress;
  if (isTrustedProxy(peer)) {
    const forwarded = req.headers['x-forwarded-for'];
    const header = Array.isArray(forwarded) ? forwarded[0] : forwarded;
    if (typeof header === 'string' && header.length > 0) {
      // Left-most entry is the original client as appended by the proxy chain.
      const client = header.split(',')[0]?.trim();
      if (client) return client;
    }
  }
  return req.ip ?? peer ?? 'unknown';
}

/**
 * Per-route budget configuration. `windowMs`/`max` are the documented knobs;
 * the rest are forwarded to express-rate-limit.
 */
export interface PrincipalRateLimitOptions extends Partial<Options> {
  /** Window length in milliseconds. */
  windowMs?: number;
  /** Maximum requests per window per principal. */
  max?: number;
  /** Optional Redis-backed store; falls back to in-memory when absent. */
  store?: Store;
}

/**
 * Build the documented 429 envelope. Includes `Retry-After` so clients can
 * back off deterministically.
 */
function buildRateLimitedResponse(windowMs: number) {
  return (req: Request, res: Response) => {
    const retryAfter = Math.max(1, Math.ceil(windowMs / 1000));
    res.setHeader('Retry-After', String(retryAfter));
    res.status(429).json({
      error: {
        code: 'RATE_LIMITED',
        message: 'Too many requests, please try again later.',
        retryAfter,
      },
      status: 429,
    });
  };
}

/**
 * Shared factory to create an express-rate-limit instance with common configuration.
 *
 * Keys are principal-aware (see {@link resolveRateLimitKey}) and counters are
 * multi-instance safe when a Redis store is supplied. When Redis is
 * unavailable the caller passes no store and express-rate-limit's in-memory
 * store is used as a safe fallback.
 *
 * @param options Configuration options for express-rate-limit
 * @returns Express rate limit middleware
 */
export function createRateLimiter(options: PrincipalRateLimitOptions) {
  const windowMs = options.windowMs ?? 60 * 1000;
  return rateLimit({
    standardHeaders: true, // Return rate limit info in the `RateLimit-*` headers
    legacyHeaders: false, // Disable the `X-RateLimit-*` headers
    ...options,
    windowMs,
    keyGenerator: options.keyGenerator ?? ((req) => resolveRateLimitKey(req as AuthenticatedRequest)),
    handler: options.handler ?? buildRateLimitedResponse(windowMs),
  });
}

export const globalRateLimiter = createRateLimiter({
  windowMs: 1 * 60 * 1000, // 1 minute
  max: 100, // Limit each principal to 100 requests per `window` (here, per minute)
  standardHeaders: true, // Return rate limit info in the `RateLimit-*` headers
  legacyHeaders: false, // Disable the `X-RateLimit-*` headers
  // The Prometheus scrape endpoint must never be throttled: a 429 would make
  // Prometheus mark the target down and blind the whole alerting pipeline.
  // It is protected by its own network/token guard instead.
  skip: (req) => req.path === '/metrics' || req.path.startsWith('/metrics/'),
});

/**
 * Per-route budgets for expensive operations (issue #72). Each entry is a
 * documented budget; callers mount the matching limiter on the route.
 */
export const expensiveOperationBudgets = {
  account: { windowMs: 60 * 1000, max: 30 },
  export: { windowMs: 60 * 1000, max: 10 },
  analytics: { windowMs: 60 * 1000, max: 60 },
  replay: { windowMs: 60 * 1000, max: 20 },
  webhook: { windowMs: 60 * 1000, max: 120 },
} as const;

export type ExpensiveOperation = keyof typeof expensiveOperationBudgets;

/**
 * Create a principal-aware limiter for an expensive operation using its
 * documented budget. Pass a Redis store to make counters multi-instance safe;
 * omit it to fall back to the in-memory store.
 */
export function createExpensiveOperationLimiter(
  operation: ExpensiveOperation,
  options: PrincipalRateLimitOptions = {},
) {
  return createRateLimiter({
    ...expensiveOperationBudgets[operation],
    ...options,
  });
}
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
});
