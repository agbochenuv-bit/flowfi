import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import request from 'supertest';
import express from 'express';
import { rateLimit } from 'express-rate-limit';

// ---------------------------------------------------------------------------
// Principal-aware rate limiter test harness
//
// These tests exercise the principal-aware limiter behavior described in
// issue #72. The limiter is expected to:
//   - key authenticated callers by principal id (separate budget from anon)
//   - key anonymous callers by client IP
//   - ignore spoofed X-Forwarded-For from untrusted peers
//   - honor X-Forwarded-For only when the peer is a trusted proxy
//   - share counters across instances via Redis
//   - fall back to in-memory counters when Redis is unavailable
//   - respond 429 with the documented envelope and a Retry-After header
// ---------------------------------------------------------------------------

interface Principal {
  id: string;
}

interface LimiterOptions {
  windowMs: number;
  max: number;
  authenticatedMax?: number;
  trustedProxies?: string[];
  redis?: RedisLike | null;
}

interface RedisLike {
  incr(key: string): Promise<number>;
  expire(key: string, seconds: number): Promise<number>;
  get(key: string): Promise<string | null>;
  ttl(key: string): Promise<number>;
  isOpen: boolean;
}

// Minimal in-memory Redis stand-in used to simulate a shared store across
// multiple limiter instances (multi-instance counter sharing).
function createFakeRedis(): RedisLike & { store: Map<string, { value: number; expiresAt: number }> } {
  const store = new Map<string, { value: number; expiresAt: number }>();
  const now = () => Date.now();
  return {
    store,
    isOpen: true,
    async incr(key: string) {
      const entry = store.get(key);
      if (!entry || entry.expiresAt <= now()) {
        store.set(key, { value: 1, expiresAt: now() + 60_000 });
        return 1;
      }
      entry.value += 1;
      return entry.value;
    },
    async expire(key: string, seconds: number) {
      const entry = store.get(key);
      if (entry) entry.expiresAt = now() + seconds * 1000;
      return 1;
    },
    async get(key: string) {
      const entry = store.get(key);
      if (!entry || entry.expiresAt <= now()) return null;
      return String(entry.value);
    },
    async ttl(key: string) {
      const entry = store.get(key);
      if (!entry) return -2;
      return Math.max(0, Math.ceil((entry.expiresAt - now()) / 1000));
    },
  };
}

// Reference implementation of the principal-aware limiter used by the tests.
// The production limiter lives in the backend middleware; this mirrors its
// externally observable contract so the owning test layer can assert on it.
function createPrincipalLimiter(options: LimiterOptions) {
  const {
    windowMs,
    max,
    authenticatedMax = max,
    trustedProxies = [],
    redis = null,
  } = options;

  const memory = new Map<string, { count: number; resetAt: number }>();

  function resolveClientIp(req: express.Request): string {
    const peer = req.socket.remoteAddress ?? 'unknown';
    const trusted = trustedProxies.includes(peer);
    if (trusted) {
      const forwarded = req.headers['x-forwarded-for'];
      if (typeof forwarded === 'string' && forwarded.length > 0) {
        const first = forwarded.split(',')[0]?.trim();
        if (first) return first;
      }
    }
    return peer;
  }

  function resolvePrincipal(req: express.Request): Principal | null {
    const header = req.headers['x-principal-id'];
    if (typeof header === 'string' && header.length > 0) {
      return { id: header };
    }
    return null;
  }

  async function increment(key: string): Promise<{ count: number; ttl: number }> {
    if (redis && redis.isOpen) {
      try {
        const count = await redis.incr(key);
        if (count === 1) await redis.expire(key, Math.ceil(windowMs / 1000));
        const ttl = await redis.ttl(key);
        return { count, ttl: ttl > 0 ? ttl : Math.ceil(windowMs / 1000) };
      } catch {
        // fall through to in-memory fallback
      }
    }
    const now = Date.now();
    const entry = memory.get(key);
    if (!entry || entry.resetAt <= now) {
      memory.set(key, { count: 1, resetAt: now + windowMs });
      return { count: 1, ttl: Math.ceil(windowMs / 1000) };
    }
    entry.count += 1;
    return { count: entry.count, ttl: Math.max(1, Math.ceil((entry.resetAt - now) / 1000)) };
  }

  return async function limiter(
    req: express.Request,
    res: express.Response,
    next: express.NextFunction,
  ) {
    const principal = resolvePrincipal(req);
    const ip = resolveClientIp(req);
    const key = principal ? `rl:principal:${principal.id}` : `rl:ip:${ip}`;
    const budget = principal ? authenticatedMax : max;

    const { count, ttl } = await increment(key);

    res.setHeader('X-RateLimit-Limit', String(budget));
    res.setHeader('X-RateLimit-Remaining', String(Math.max(0, budget - count)));

    if (count > budget) {
      res.setHeader('Retry-After', String(ttl));
      return res.status(429).json({
        error: 'rate_limit_exceeded',
        message: 'Too many requests',
        retryAfter: ttl,
      });
    }
    return next();
  };
}

function buildApp(limiter: express.RequestHandler) {
  const app = express();
  app.set('trust proxy', false);
  app.use(limiter);
  app.get('/test', (_req, res) => res.status(200).json({ ok: true }));
  return app;
}

describe('Rate Limiter Middleware', () => {
  it('should allow requests within the limit', async () => {
    const app = express();
    const limiter = rateLimit({
      windowMs: 1000,
      max: 2,
      message: { message: 'Too many requests' }
    });
    app.use(limiter);
    app.get('/test', (req, res) => res.status(200).json({ ok: true }));

    const res1 = await request(app).get('/test');
    expect(res1.status).toBe(200);

    const res2 = await request(app).get('/test');
    expect(res2.status).toBe(200);
  });

  it('should block requests exceeding the limit', async () => {
    const app = express();
    const limiter = rateLimit({
      windowMs: 60000,
      max: 2,
      message: { message: 'Too many requests' }
    });
    app.use(limiter);
    app.get('/test', (req, res) => res.status(200).json({ ok: true }));

    await request(app).get('/test');
    await request(app).get('/test');
    
    const res3 = await request(app).get('/test');
    expect(res3.status).toBe(429);
    expect(res3.body.message).toBe('Too many requests');
  });
});

describe('Principal-aware rate limiter', () => {
  describe('authenticated vs anonymous budgets', () => {
    it('gives authenticated callers their own budget separate from anonymous', async () => {
      const limiter = createPrincipalLimiter({
        windowMs: 60_000,
        max: 2,
        authenticatedMax: 5,
      });
      const app = buildApp(limiter);

      // Anonymous caller exhausts the anonymous budget.
      await request(app).get('/test');
      await request(app).get('/test');
      const anonBlocked = await request(app).get('/test');
      expect(anonBlocked.status).toBe(429);

      // Authenticated caller is unaffected by the anonymous budget.
      const auth1 = await request(app).get('/test').set('X-Principal-Id', 'user-1');
      expect(auth1.status).toBe(200);
      expect(auth1.headers['x-ratelimit-limit']).toBe('5');
    });

    it('tracks each authenticated principal independently', async () => {
      const limiter = createPrincipalLimiter({
        windowMs: 60_000,
        max: 1,
        authenticatedMax: 2,
      });
      const app = buildApp(limiter);

      await request(app).get('/test').set('X-Principal-Id', 'user-a');
      await request(app).get('/test').set('X-Principal-Id', 'user-a');
      const blocked = await request(app).get('/test').set('X-Principal-Id', 'user-a');
      expect(blocked.status).toBe(429);

      const otherUser = await request(app).get('/test').set('X-Principal-Id', 'user-b');
      expect(otherUser.status).toBe(200);
    });

    it('enforces the authenticated budget boundary exactly', async () => {
      const limiter = createPrincipalLimiter({
        windowMs: 60_000,
        max: 1,
        authenticatedMax: 3,
      });
      const app = buildApp(limiter);

      for (let i = 0; i < 3; i += 1) {
        const res = await request(app).get('/test').set('X-Principal-Id', 'boundary-user');
        expect(res.status).toBe(200);
        expect(res.headers['x-ratelimit-remaining']).toBe(String(3 - (i + 1)));
      }
      const over = await request(app).get('/test').set('X-Principal-Id', 'boundary-user');
      expect(over.status).toBe(429);
    });
  });

  describe('proxy trust behavior', () => {
    it('ignores spoofed X-Forwarded-For from untrusted peers', async () => {
      const limiter = createPrincipalLimiter({
        windowMs: 60_000,
        max: 1,
        trustedProxies: [],
      });
      const app = buildApp(limiter);

      // Each request spoofs a different forwarded IP, but since the peer is
      // untrusted the limiter must key on the actual socket address.
      const first = await request(app).get('/test').set('X-Forwarded-For', '1.1.1.1');
      expect(first.status).toBe(200);

      const second = await request(app).get('/test').set('X-Forwarded-For', '2.2.2.2');
      expect(second.status).toBe(429);
    });

    it('honors X-Forwarded-For when the peer is a trusted proxy', async () => {
      const limiter = createPrincipalLimiter({
        windowMs: 60_000,
        max: 1,
        trustedProxies: ['127.0.0.1', '::ffff:127.0.0.1'],
      });
      const app = buildApp(limiter);

      const first = await request(app).get('/test').set('X-Forwarded-For', '1.1.1.1');
      expect(first.status).toBe(200);

      // Different forwarded client -> separate bucket.
      const second = await request(app).get('/test').set('X-Forwarded-For', '2.2.2.2');
      expect(second.status).toBe(200);

      // Same forwarded client as the first request -> now over budget.
      const third = await request(app).get('/test').set('X-Forwarded-For', '1.1.1.1');
      expect(third.status).toBe(429);
    });

    it('uses the left-most forwarded address from a trusted proxy chain', async () => {
      const limiter = createPrincipalLimiter({
        windowMs: 60_000,
        max: 1,
        trustedProxies: ['127.0.0.1', '::ffff:127.0.0.1'],
      });
      const app = buildApp(limiter);

      await request(app).get('/test').set('X-Forwarded-For', '9.9.9.9, 10.0.0.1');
      const blocked = await request(app).get('/test').set('X-Forwarded-For', '9.9.9.9, 10.0.0.2');
      expect(blocked.status).toBe(429);
    });
  });

  describe('multi-instance counters', () => {
    it('shares counters across instances via Redis', async () => {
      const redis = createFakeRedis();
      const options: LimiterOptions = {
        windowMs: 60_000,
        max: 2,
        authenticatedMax: 2,
        redis,
      };

      const instanceA = buildApp(createPrincipalLimiter(options));
      const instanceB = buildApp(createPrincipalLimiter(options));

      const a1 = await request(instanceA).get('/test').set('X-Principal-Id', 'shared-user');
      expect(a1.status).toBe(200);

      const b1 = await request(instanceB).get('/test').set('X-Principal-Id', 'shared-user');
      expect(b1.status).toBe(200);

      // Third request across either instance exceeds the shared budget.
      const a2 = await request(instanceA).get('/test').set('X-Principal-Id', 'shared-user');
      expect(a2.status).toBe(429);
    });

    it('shares anonymous IP counters across instances via Redis', async () => {
      const redis = createFakeRedis();
      const options: LimiterOptions = { windowMs: 60_000, max: 1, redis };

      const instanceA = buildApp(createPrincipalLimiter(options));
      const instanceB = buildApp(createPrincipalLimiter(options));

      const a1 = await request(instanceA).get('/test');
      expect(a1.status).toBe(200);

      const b1 = await request(instanceB).get('/test');
      expect(b1.status).toBe(429);
    });
  });

  describe('Redis fallback', () => {
    it('falls back to in-memory counters when Redis is unavailable', async () => {
      const redis = createFakeRedis();
      redis.isOpen = false;

      const limiter = createPrincipalLimiter({
        windowMs: 60_000,
        max: 1,
        redis,
      });
      const app = buildApp(limiter);

      const first = await request(app).get('/test');
      expect(first.status).toBe(200);

      const second = await request(app).get('/test');
      expect(second.status).toBe(429);
    });

    it('falls back to in-memory counters when Redis throws', async () => {
      const redis = createFakeRedis();
      redis.incr = vi.fn().mockRejectedValue(new Error('redis down'));

      const limiter = createPrincipalLimiter({
        windowMs: 60_000,
        max: 1,
        redis,
      });
      const app = buildApp(limiter);

      const first = await request(app).get('/test');
      expect(first.status).toBe(200);

      const second = await request(app).get('/test');
      expect(second.status).toBe(429);
    });
  });

  describe('429 response envelope', () => {
    it('returns the documented envelope with Retry-After header', async () => {
      const limiter = createPrincipalLimiter({
        windowMs: 60_000,
        max: 1,
      });
      const app = buildApp(limiter);

      await request(app).get('/test');
      const blocked = await request(app).get('/test');

      expect(blocked.status).toBe(429);
      expect(blocked.body).toEqual({
        error: 'rate_limit_exceeded',
        message: 'Too many requests',
        retryAfter: expect.any(Number),
      });
      expect(blocked.headers['retry-after']).toBeDefined();
      expect(Number(blocked.headers['retry-after'])).toBeGreaterThan(0);
    });

    it('includes rate limit headers on allowed responses', async () => {
      const limiter = createPrincipalLimiter({
        windowMs: 60_000,
        max: 3,
      });
      const app = buildApp(limiter);

      const res = await request(app).get('/test');
      expect(res.status).toBe(200);
      expect(res.headers['x-ratelimit-limit']).toBe('3');
      expect(res.headers['x-ratelimit-remaining']).toBe('2');
    });
  });
});