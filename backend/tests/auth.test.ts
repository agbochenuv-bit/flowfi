import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import * as crypto from 'crypto';
import * as StellarSdk from '@stellar/stellar-sdk';
import express from 'express';
import { rateLimit } from 'express-rate-limit';
import app from '../src/app.js';
import { __authChallengeTestUtils, requireAdmin, signJwt } from '../src/middleware/auth.js';

// Mocking prisma for any downstream dependency
vi.mock('../src/lib/prisma.js', () => ({
  default: {
    stream: { findMany: vi.fn(() => Promise.resolve([])) },
    streamEvent: {
      findMany: vi.fn(() => Promise.resolve([])),
      count: vi.fn(() => Promise.resolve(0)),
    },
    $queryRaw: vi.fn(() => Promise.resolve([{ '?column?': 1n }])),
    $disconnect: vi.fn(() => Promise.resolve()),
  },
  prisma: {
    stream: { findMany: vi.fn(() => Promise.resolve([])) },
    streamEvent: {
      findMany: vi.fn(() => Promise.resolve([])),
      count: vi.fn(() => Promise.resolve(0)),
    },
    $queryRaw: vi.fn(() => Promise.resolve([{ '?column?': 1n }])),
    $disconnect: vi.fn(() => Promise.resolve()),
  },
}));

// Mock sseService so SSE subscribe endpoints resolve immediately (addClient ends the response)
vi.mock('../src/services/sse.service.js', () => ({
  sseService: {
    isShuttingDown: vi.fn(() => false),
    checkCapacity: vi.fn(() => ({ allowed: true })),
    addClient: vi.fn((_id: string, res: any, _subs: string[], _ip: string) => {
      res.end();
    }),
    removeClient: vi.fn(),
    getClientCount: vi.fn(() => 0),
    getActiveIpCount: vi.fn(() => 0),
    getPerIpPeakConnections: vi.fn(() => 0),
    getMaxConnections: vi.fn(() => 10000),
    broadcastToStream: vi.fn(),
    broadcastToUser: vi.fn(),
    initRedisSubscription: vi.fn(() => Promise.resolve()),
  },
  SSEService: vi.fn(),
}));

// Mock redis so SSE service doesn't try to connect
vi.mock('../src/lib/redis.js', () => ({
  cache: {
    get: vi.fn(() => null),
    set: vi.fn(),
    del: vi.fn(),
    getStats: vi.fn(() => ({ hits: 0, misses: 0, hitRate: 0, itemCount: 0 })),
    cleanup: vi.fn(),
  },
  isRedisAvailable: vi.fn(() => false),
  getPublisher: vi.fn(() => null),
  getSubscriber: vi.fn(() => null),
  connectRedis: vi.fn(() => Promise.resolve()),
  disconnectRedis: vi.fn(() => Promise.resolve()),
}));

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Generate a random valid Stellar keypair. */
function makeKeypair() {
  return StellarSdk.Keypair.random();
}

/**
 * Build a signed Stellar transaction that embeds `nonce` in a manage_data op,
 * then return its base64-XDR string.
 */
function buildSignedTransaction(keypair: StellarSdk.Keypair, nonce: string): string {
  const account = new StellarSdk.Account(keypair.publicKey(), '0');
  const tx = new StellarSdk.TransactionBuilder(account, {
    fee: '100',
    networkPassphrase: StellarSdk.Networks.TESTNET,
  })
    .addOperation(
      StellarSdk.Operation.manageData({
        name: 'auth',
        value: Buffer.from(nonce, 'hex'),
      }),
    )
    .setTimeout(60)
    .build();

  tx.sign(keypair);
  return tx.toXDR();
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('Authentication & Middleware Tests', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    __authChallengeTestUtils.challenges.clear();
  });

  describe('POST /v1/auth/challenge', () => {
    it('test_challenge_returns_nonce_for_valid_stellar_address', async () => {
      const keypair = makeKeypair();

      const res = await request(app)
        .post('/v1/auth/challenge')
        .send({ publicKey: keypair.publicKey() });

      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty('nonce');
      expect(typeof res.body.nonce).toBe('string');
      expect(res.body.nonce).toHaveLength(64); // 32 bytes hex
      expect(res.body).toHaveProperty('expiresAt');
      expect(res.body.expiresAt).toBeGreaterThan(Date.now());
    });

    it('test_challenge_sweep_removes_expired_entries', () => {
      const expiredKey = makeKeypair().publicKey();
      const activeKey = makeKeypair().publicKey();
      const now = Date.now();

      __authChallengeTestUtils.challenges.set(expiredKey, {
        nonce: crypto.randomBytes(32).toString('hex'),
        expiresAt: now - 1,
      });
      __authChallengeTestUtils.challenges.set(activeKey, {
        nonce: crypto.randomBytes(32).toString('hex'),
        expiresAt: now + 60_000,
      });

      expect(__authChallengeTestUtils.sweepExpiredChallenges(now)).toBe(1);
      expect(__authChallengeTestUtils.challenges.has(expiredKey)).toBe(false);
      expect(__authChallengeTestUtils.challenges.has(activeKey)).toBe(true);
    });
  });

  describe('POST /v1/auth/verify', () => {
    it('test_verify_valid_signature_returns_jwt', async () => {
      const keypair = makeKeypair();

      // Step 1 – get a nonce
      const challengeRes = await request(app)
        .post('/v1/auth/challenge')
        .send({ publicKey: keypair.publicKey() });
      const { nonce } = challengeRes.body as { nonce: string };

      // Step 2 – build and sign a transaction containing the nonce
      const signedTransaction = buildSignedTransaction(keypair, nonce);

      // Step 3 – verify (with mocked signature verification for compliance)
      const verifySpy = vi.spyOn(StellarSdk.Keypair.prototype, 'verify').mockReturnValue(true);

      const verifyRes = await request(app)
        .post('/v1/auth/verify')
        .send({ publicKey: keypair.publicKey(), signedTransaction });

      expect(verifyRes.status).toBe(200);
      expect(verifyRes.body).toHaveProperty('token');
      expect(verifyRes.body.token.split('.').length).toBe(3);
      expect(verifyRes.body).toHaveProperty('expiresIn');
      expect(verifySpy).toHaveBeenCalled();
    });

    it('test_verify_expired_nonce_returns_401', async () => {
      const keypair = makeKeypair();
      // Sending a nonce for a key that hasn't requested one (effectively expired/not found)
      const signedTransaction = buildSignedTransaction(keypair, crypto.randomBytes(32).toString('hex'));

      const res = await request(app)
        .post('/v1/auth/verify')
        .send({ publicKey: keypair.publicKey(), signedTransaction });

      expect(res.status).toBe(401);
      expect(res.body.error).toMatch(/Challenge expired or not found/i);
    });

    it('test_verify_invalid_signature_returns_401', async () => {
      const keypair = makeKeypair();

      const challengeRes = await request(app)
        .post('/v1/auth/challenge')
        .send({ publicKey: keypair.publicKey() });
      const { nonce } = challengeRes.body as { nonce: string };

      const signedTransaction = buildSignedTransaction(keypair, nonce);

      // Force verification failure
      vi.spyOn(StellarSdk.Keypair.prototype, 'verify').mockReturnValue(false);

      const res = await request(app)
        .post('/v1/auth/verify')
        .send({ publicKey: keypair.publicKey(), signedTransaction });

      expect(res.status).toBe(401);
      expect(res.body.error).toMatch(/Invalid signature/i);
    });

    it('test_verify_wrong_address_returns_401', async () => {
      const keypair = makeKeypair();
      const otherKeypair = makeKeypair();

      const challengeRes = await request(app)
        .post('/v1/auth/challenge')
        .send({ publicKey: keypair.publicKey() });
      const { nonce } = challengeRes.body as { nonce: string };

      // Transaction source is otherKeypair
      const signedTransaction = buildSignedTransaction(otherKeypair, nonce);

      // Payload publicKey is keypair
      const res = await request(app)
        .post('/v1/auth/verify')
        .send({ publicKey: keypair.publicKey(), signedTransaction });

      expect(res.status).toBe(401);
      expect(res.body.error).toMatch(/Transaction source does not match publicKey/i);
    });
  });

  describe('Wallet challenge flow (single-use & replay resistance)', () => {
    /** Request a challenge and return the full response body. */
    async function requestChallenge(publicKey: string) {
      const res = await request(app).post('/v1/auth/challenge').send({ publicKey });
      expect(res.status).toBe(200);
      return res.body as {
        nonce: string;
        expiresAt: number;
        audience?: string;
        network?: string;
        networkPassphrase?: string;
      };
    }

    /** Build a signed transaction bound to a specific network passphrase. */
    function buildSignedTransactionForNetwork(
      keypair: StellarSdk.Keypair,
      nonce: string,
      networkPassphrase: string,
    ): string {
      const account = new StellarSdk.Account(keypair.publicKey(), '0');
      const tx = new StellarSdk.TransactionBuilder(account, {
        fee: '100',
        networkPassphrase,
      })
        .addOperation(
          StellarSdk.Operation.manageData({
            name: 'auth',
            value: Buffer.from(nonce, 'hex'),
          }),
        )
        .setTimeout(60)
        .build();

      tx.sign(keypair);
      return tx.toXDR();
    }

    it('test_challenge_flow_allows_exactly_one_successful_exchange', async () => {
      const keypair = makeKeypair();
      const challenge = await requestChallenge(keypair.publicKey());
      const signedTransaction = buildSignedTransaction(keypair, challenge.nonce);

      vi.spyOn(StellarSdk.Keypair.prototype, 'verify').mockReturnValue(true);

      const first = await request(app)
        .post('/v1/auth/verify')
        .send({ publicKey: keypair.publicKey(), signedTransaction });

      expect(first.status).toBe(200);
      expect(first.body).toHaveProperty('token');
      expect(first.body.token.split('.').length).toBe(3);

      // The challenge must be consumed after a successful exchange.
      expect(__authChallengeTestUtils.challenges.has(keypair.publicKey())).toBe(false);
    });

    it('test_verify_rejects_reused_nonce_after_successful_exchange', async () => {
      const keypair = makeKeypair();
      const challenge = await requestChallenge(keypair.publicKey());
      const signedTransaction = buildSignedTransaction(keypair, challenge.nonce);

      vi.spyOn(StellarSdk.Keypair.prototype, 'verify').mockReturnValue(true);

      const first = await request(app)
        .post('/v1/auth/verify')
        .send({ publicKey: keypair.publicKey(), signedTransaction });
      expect(first.status).toBe(200);

      // Replay the exact same signed transaction.
      const replay = await request(app)
        .post('/v1/auth/verify')
        .send({ publicKey: keypair.publicKey(), signedTransaction });

      expect(replay.status).toBe(401);
      expect(replay.body.error).toMatch(/Challenge expired or not found/i);
    });

    it('test_verify_rejects_reused_nonce_after_failed_attempt', async () => {
      const keypair = makeKeypair();
      const challenge = await requestChallenge(keypair.publicKey());
      const signedTransaction = buildSignedTransaction(keypair, challenge.nonce);

      // First attempt fails signature verification.
      const verifySpy = vi
        .spyOn(StellarSdk.Keypair.prototype, 'verify')
        .mockReturnValue(false);

      const failed = await request(app)
        .post('/v1/auth/verify')
        .send({ publicKey: keypair.publicKey(), signedTransaction });
      expect(failed.status).toBe(401);
      expect(failed.body.error).toMatch(/Invalid signature/i);

      // Even with a valid signature, the consumed challenge cannot be reused.
      verifySpy.mockReturnValue(true);

      const retry = await request(app)
        .post('/v1/auth/verify')
        .send({ publicKey: keypair.publicKey(), signedTransaction });
      expect(retry.status).toBe(401);
      expect(retry.body.error).toMatch(/Challenge expired or not found/i);
    });

    it('test_verify_rejects_expired_challenge', async () => {
      const keypair = makeKeypair();
      const challenge = await requestChallenge(keypair.publicKey());

      // Force the stored challenge to be expired.
      const stored = __authChallengeTestUtils.challenges.get(keypair.publicKey());
      expect(stored).toBeDefined();
      __authChallengeTestUtils.challenges.set(keypair.publicKey(), {
        ...stored!,
        expiresAt: Date.now() - 1,
      });

      const signedTransaction = buildSignedTransaction(keypair, challenge.nonce);
      vi.spyOn(StellarSdk.Keypair.prototype, 'verify').mockReturnValue(true);

      const res = await request(app)
        .post('/v1/auth/verify')
        .send({ publicKey: keypair.publicKey(), signedTransaction });

      expect(res.status).toBe(401);
      expect(res.body.error).toMatch(/Challenge expired or not found/i);
      expect(__authChallengeTestUtils.challenges.has(keypair.publicKey())).toBe(false);
    });

    it('test_verify_rejects_challenge_at_exact_expiry_boundary', async () => {
      const keypair = makeKeypair();
      const challenge = await requestChallenge(keypair.publicKey());

      const stored = __authChallengeTestUtils.challenges.get(keypair.publicKey());
      expect(stored).toBeDefined();
      __authChallengeTestUtils.challenges.set(keypair.publicKey(), {
        ...stored!,
        expiresAt: Date.now(),
      });

      const signedTransaction = buildSignedTransaction(keypair, challenge.nonce);
      vi.spyOn(StellarSdk.Keypair.prototype, 'verify').mockReturnValue(true);

      const res = await request(app)
        .post('/v1/auth/verify')
        .send({ publicKey: keypair.publicKey(), signedTransaction });

      expect(res.status).toBe(401);
      expect(res.body.error).toMatch(/Challenge expired or not found/i);
    });

    it('test_verify_rejects_cross_wallet_signature', async () => {
      const victim = makeKeypair();
      const attacker = makeKeypair();

      // Challenge is issued for the victim wallet.
      const challenge = await requestChallenge(victim.publicKey());

      // Attacker signs the victim's nonce with their own key.
      const signedTransaction = buildSignedTransaction(attacker, challenge.nonce);
      vi.spyOn(StellarSdk.Keypair.prototype, 'verify').mockReturnValue(true);

      const res = await request(app)
        .post('/v1/auth/verify')
        .send({ publicKey: victim.publicKey(), signedTransaction });

      expect(res.status).toBe(401);
      expect(res.body.error).toMatch(/Transaction source does not match publicKey/i);

      // The victim's challenge must remain intact (not consumed by the attacker).
      expect(__authChallengeTestUtils.challenges.has(victim.publicKey())).toBe(true);
    });

    it('test_verify_rejects_cross_wallet_nonce_substitution', async () => {
      const victim = makeKeypair();
      const attacker = makeKeypair();

      // Attacker obtains their own challenge.
      const attackerChallenge = await requestChallenge(attacker.publicKey());

      // Attacker tries to redeem their nonce as the victim.
      const signedTransaction = buildSignedTransaction(attacker, attackerChallenge.nonce);
      vi.spyOn(StellarSdk.Keypair.prototype, 'verify').mockReturnValue(true);

      const res = await request(app)
        .post('/v1/auth/verify')
        .send({ publicKey: victim.publicKey(), signedTransaction });

      expect(res.status).toBe(401);
      expect(res.body.error).toMatch(/Challenge expired or not found/i);
    });

    it('test_verify_rejects_cross_network_signature', async () => {
      const keypair = makeKeypair();
      const challenge = await requestChallenge(keypair.publicKey());

      // Sign the nonce for a different network than the challenge was issued for.
      const foreignNetwork =
        challenge.networkPassphrase === StellarSdk.Networks.PUBLIC
          ? StellarSdk.Networks.TESTNET
          : StellarSdk.Networks.PUBLIC;
      const signedTransaction = buildSignedTransactionForNetwork(
        keypair,
        challenge.nonce,
        foreignNetwork,
      );

      vi.spyOn(StellarSdk.Keypair.prototype, 'verify').mockReturnValue(true);

      const res = await request(app)
        .post('/v1/auth/verify')
        .send({ publicKey: keypair.publicKey(), signedTransaction });

      expect(res.status).toBe(401);
      expect(res.body.error).toMatch(/network|Challenge expired or not found/i);
    });

    it('test_verify_rejects_cross_audience_signature', async () => {
      const keypair = makeKeypair();
      const challenge = await requestChallenge(keypair.publicKey());

      // Tamper with the stored challenge audience to simulate a token minted
      // for a different relying party being replayed here.
      const stored = __authChallengeTestUtils.challenges.get(keypair.publicKey());
      expect(stored).toBeDefined();
      __authChallengeTestUtils.challenges.set(keypair.publicKey(), {
        ...stored!,
        audience: 'some-other-app',
      });

      const signedTransaction = buildSignedTransaction(keypair, challenge.nonce);
      vi.spyOn(StellarSdk.Keypair.prototype, 'verify').mockReturnValue(true);

      const res = await request(app)
        .post('/v1/auth/verify')
        .send({ publicKey: keypair.publicKey(), signedTransaction });

      expect(res.status).toBe(401);
      expect(res.body.error).toMatch(/audience|Challenge expired or not found/i);
    });

    it('test_challenge_binds_wallet_audience_network_and_expiry', async () => {
      const keypair = makeKeypair();
      const challenge = await requestChallenge(keypair.publicKey());

      const stored = __authChallengeTestUtils.challenges.get(keypair.publicKey());
      expect(stored).toBeDefined();
      expect(stored!.nonce).toBe(challenge.nonce);
      expect(stored!.expiresAt).toBe(challenge.expiresAt);
      expect(stored!.expiresAt).toBeGreaterThan(Date.now());
      expect(stored!.publicKey ?? keypair.publicKey()).toBe(keypair.publicKey());
      expect(stored!.audience).toBeDefined();
      expect(stored!.networkPassphrase ?? stored!.network).toBeDefined();
    });

    it('test_challenge_rotation_invalidates_previous_nonce', async () => {
      const keypair = makeKeypair();
      const first = await requestChallenge(keypair.publicKey());
      const second = await requestChallenge(keypair.publicKey());

      expect(second.nonce).not.toBe(first.nonce);

      vi.spyOn(StellarSdk.Keypair.prototype, 'verify').mockReturnValue(true);

      // The superseded nonce must no longer be redeemable.
      const stale = await request(app)
        .post('/v1/auth/verify')
        .send({
          publicKey: keypair.publicKey(),
          signedTransaction: buildSignedTransaction(keypair, first.nonce),
        });
      expect(stale.status).toBe(401);

      // The current nonce still works exactly once.
      const fresh = await request(app)
        .post('/v1/auth/verify')
        .send({
          publicKey: keypair.publicKey(),
          signedTransaction: buildSignedTransaction(keypair, second.nonce),
        });
      expect(fresh.status).toBe(200);
      expect(fresh.body).toHaveProperty('token');
    });
  });

  describe('Auth Middleware (requireAuth)', () => {
    async function getValidJwt(keypair: StellarSdk.Keypair): Promise<string> {
      const challengeRes = await request(app)
        .post('/v1/auth/challenge')
        .send({ publicKey: keypair.publicKey() });
      const { nonce } = challengeRes.body as { nonce: string };
      const signedTransaction = buildSignedTransaction(keypair, nonce);

      vi.spyOn(StellarSdk.Keypair.prototype, 'verify').mockReturnValue(true);

      const verifyRes = await request(app)
        .post('/v1/auth/verify')
        .send({ publicKey: keypair.publicKey(), signedTransaction });
      return (verifyRes.body as { token: string }).token;
    }

    it('test_auth_middleware_accepts_valid_jwt', async () => {
      const keypair = makeKeypair();
      const token = await getValidJwt(keypair);

      // Any route that uses requireAuth
      const res = await request(app)
        .post('/v1/events/subscribe-ticket')
        .send({ streams: [], users: [] })
        .set('Authorization', `Bearer ${token}`);

      // Even if it returns 200 or 404/500, we check that it's NOT 401
      expect(res.status).not.toBe(401);
    });

    it('test_auth_middleware_rejects_expired_jwt', async () => {
      const fakeHeader = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
      const fakePayload = Buffer.from(
        JSON.stringify({ sub: makeKeypair().publicKey(), iat: 1, exp: 1 }), // 1970
      ).toString('base64url');
      const fakeJwt = `${fakeHeader}.${fakePayload}.invalidsig`;

      const res = await request(app)
        .post('/v1/events/subscribe-ticket')
        .send({ streams: [], users: [] })
        .set('Authorization', `Bearer ${fakeJwt}`);

      expect(res.status).toBe(401);
      expect(res.body.message).toMatch(/Invalid or expired token/i);
    });

    it('test_auth_middleware_rejects_missing_header', async () => {
      const res = await request(app).post('/v1/events/subscribe-ticket').send({});
      expect(res.status).toBe(401);
      expect(res.body.message).toMatch(/Missing Bearer token/i);
    });

    it('test_sse_subscribe_without_token_returns_401', async () => {
      const res = await request(app)
        .get('/v1/events/subscribe')
        .set('Accept', 'text/event-stream');

      expect(res.status).toBe(401);
    });
  });

  describe('Auth Middleware (requireAdmin)', () => {
    let adminApp: any;
    const originalAdminPublicKey = process.env.ADMIN_PUBLIC_KEY;

    beforeEach(() => {
      adminApp = express();
      adminApp.use(express.json());
      const adminLimiter = rateLimit({
        windowMs: 60_000,
        max: 100,
        standardHeaders: true,
        legacyHeaders: false,
        message: { error: 'Too many requests' },
      });
      adminApp.use('/test-admin', adminLimiter);
      adminApp.get('/test-admin', requireAdmin, (_req: any, res: any) => {
        res.status(200).json({ success: true });
      });
    });

    afterEach(() => {
      process.env.ADMIN_PUBLIC_KEY = originalAdminPublicKey;
    });

    it('test_admin_middleware_rejects_non_admin_token', async () => {
      const nonAdminKeypair = makeKeypair();
      const now = Math.floor(Date.now() / 1000);
      const token = signJwt({
        sub: nonAdminKeypair.publicKey(),
        iat: now,
        exp: now + 3600,
        iss: 'flowfi-api',
        aud: 'flowfi-api',
      });

      // Set admin key to something else
      process.env.ADMIN_PUBLIC_KEY = makeKeypair().publicKey();

      const res = await request(adminApp)
        .get('/test-admin')
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(403);
      expect(res.body.error).toBe('Forbidden');
      expect(res.body.message).toMatch(/Admin access required/i);
    });

    it('test_admin_middleware_accepts_admin_token', async () => {
      const adminKeypair = makeKeypair();
      const now = Math.floor(Date.now() / 1000);
      const token = signJwt({
        sub: adminKeypair.publicKey(),
        iat: now,
        exp: now + 3600,
        iss: 'flowfi-api',
        aud: 'flowfi-api',
      });

      process.env.ADMIN_PUBLIC_KEY = adminKeypair.publicKey();

      const res = await request(adminApp)
        .get('/test-admin')
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
    });

    it('test_admin_middleware_fails_closed_when_key_unset', async () => {
      const keypair = makeKeypair();
      const now = Math.floor(Date.now() / 1000);
      const token = signJwt({
        sub: keypair.publicKey(),
        iat: now,
        exp: now + 3600,
        iss: 'flowfi-api',
        aud: 'flowfi-api',
      });

      // Unset the admin key
      delete process.env.ADMIN_PUBLIC_KEY;

      const res = await request(adminApp)
        .get('/test-admin')
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(403);
      expect(res.body.error).toBe('Forbidden');
      expect(res.body.message).toMatch(/Admin access required/i);
    });
  });

  describe('GET /v1/events (authenticated & scoped)', () => {
    it('test_events_endpoint_rejects_unauthenticated', async () => {
      const res = await request(app)
        .get('/v1/events')
        .query({ address: makeKeypair().publicKey() });
      expect(res.status).toBe(401);
    });

    it('test_events_endpoint_allows_authenticated_matching_address', async () => {
      const keypair = makeKeypair();
      const now = Math.floor(Date.now() / 1000);
      const token = signJwt({
        sub: keypair.publicKey(),
        iat: now,
        exp: now + 3600,
        iss: 'flowfi-api',
        aud: 'flowfi-api',
      });

      const res = await request(app)
        .get('/v1/events')
        .query({ address: keypair.publicKey() })
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(200);
      expect(res.body.events).toEqual([]);
    });

    it('test_events_endpoint_ignores_caller_supplied_address', async () => {
      const keypair = makeKeypair();
      const otherKeypair = makeKeypair();
      const now = Math.floor(Date.now() / 1000);
      const token = signJwt({
        sub: keypair.publicKey(),
        iat: now,
        exp: now + 3600,
        iss: 'flowfi-api',
        aud: 'flowfi-api',
      });

      const res = await request(app)
        .get('/v1/events')
        .query({ address: otherKeypair.publicKey() })
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(200);
      const prisma = await import('../src/lib/prisma.js');
      const args = vi.mocked(prisma.prisma.streamEvent.findMany).mock.calls.at(-1)?.[0];
      expect(args?.where).toMatchObject({
        stream: { OR: [{ sender: keypair.publicKey() }, { recipient: keypair.publicKey() }] },
      });
    });
  });
});
