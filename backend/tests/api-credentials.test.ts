import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import express, { type Request, type Response } from 'express';
import request from 'supertest';
import { Keypair } from '@stellar/stellar-sdk';

vi.mock('../src/lib/prisma.js', () => ({
  prisma: {},
  default: {},
}));

vi.mock('../src/logger.js', () => ({
  default: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

import credentialsRoutes from '../src/routes/v1/credentials.routes.js';
import {
  requireAdmin,
  requireAuth,
  requireScope,
  requireStreamOwnership,
  setStreamOwnerResolver,
  signJwt,
} from '../src/middleware/auth.js';
import {
  MAX_ACTIVE_CREDENTIALS_PER_WALLET,
  MAX_CREDENTIAL_TTL_SECONDS,
  MIN_CREDENTIAL_TTL_SECONDS,
  __apiCredentialTestUtils,
  createApiCredential,
  rotateApiCredential,
  verifyApiCredential,
} from '../src/services/api-credential.service.js';
import type { AuthenticatedRequest } from '../src/types/auth.types.js';

function makeWalletJwt(publicKey: string): string {
  const now = Math.floor(Date.now() / 1000);
  return signJwt({
    sub: publicKey,
    iat: now,
    exp: now + 3600,
    iss: 'flowfi-api',
    aud: 'flowfi-api',
  });
}

function buildTestApp() {
  const app = express();
  app.use(express.json());
  app.use('/v1/credentials', credentialsRoutes);

  app.get(
    '/v1/protected/read',
    requireAuth,
    requireScope('streams:read'),
    (req: Request, res: Response) => {
      const user = (req as AuthenticatedRequest).user;
      res.status(200).json({
        wallet: user?.publicKey,
        authMethod: user?.authMethod,
        scopes: user?.scopes ?? null,
      });
    },
  );

  app.post(
    '/v1/protected/write/:id',
    requireAuth,
    requireScope('streams:write'),
    requireStreamOwnership('id'),
    (req: Request, res: Response) => {
      const user = (req as AuthenticatedRequest).user;
      res.status(200).json({
        ok: true,
        wallet: user?.publicKey,
        streamId: req.params['id'],
      });
    },
  );

  app.get('/v1/admin/check', requireAdmin, (_req: Request, res: Response) => {
    res.status(200).json({ admin: true });
  });

  return app;
}

describe('Wallet-scoped API credentials (#232)', () => {
  const app = buildTestApp();
  const walletA = Keypair.fromRawEd25519Seed(Buffer.alloc(32, 21)).publicKey();
  const walletB = Keypair.fromRawEd25519Seed(Buffer.alloc(32, 22)).publicKey();
  const jwtA = makeWalletJwt(walletA);
  const jwtB = makeWalletJwt(walletB);

  beforeEach(() => {
    vi.clearAllMocks();
    __apiCredentialTestUtils.clearAll();
    setStreamOwnerResolver((id) => (id === '101' ? walletA : null));
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('creates a credential, returns secret once with no-store, never stores plaintext, and hides secret on subsequent reads', async () => {
    const createRes = await request(app)
      .post('/v1/credentials')
      .set('Authorization', `Bearer ${jwtA}`)
      .send({
        name: 'Treasury Sync Worker',
        scopes: ['streams:read', 'events:read', 'streams:read'],
        expiresInSeconds: 3600,
      });

    expect(createRes.status).toBe(201);
    expect(createRes.headers['cache-control']).toBe('no-store');
    expect(typeof createRes.body.secret).toBe('string');
    expect(createRes.body.secret.startsWith('ffk_test_')).toBe(true);
    expect(createRes.body.warning).toContain('will not be shown again');
    expect(createRes.body.credential).toMatchObject({
      walletAddress: walletA,
      network: 'testnet',
      name: 'Treasury Sync Worker',
      scopes: ['streams:read', 'events:read'],
      status: 'active',
    });

    const credentialId = createRes.body.credential.id as string;
    const rawSecret = createRes.body.secret as string;

    // Stored record must never contain the plaintext secret.
    const stored = __apiCredentialTestUtils.getRawRecord(credentialId);
    expect(stored).toBeDefined();
    expect(JSON.stringify(stored)).not.toContain(rawSecret);

    // Subsequent GET list & detail must never expose secret, secretHash, or secretSalt.
    const listRes = await request(app)
      .get('/v1/credentials')
      .set('Authorization', `Bearer ${jwtA}`);
    expect(listRes.status).toBe(200);
    expect(listRes.body.credentials).toHaveLength(1);
    expect(JSON.stringify(listRes.body)).not.toContain(rawSecret);
    expect(listRes.body.credentials[0]).not.toHaveProperty('secret');
    expect(listRes.body.credentials[0]).not.toHaveProperty('secretHash');
    expect(listRes.body.credentials[0]).not.toHaveProperty('secretSalt');

    const detailRes = await request(app)
      .get(`/v1/credentials/${credentialId}`)
      .set('Authorization', `Bearer ${jwtA}`);
    expect(detailRes.status).toBe(200);
    expect(JSON.stringify(detailRes.body)).not.toContain(rawSecret);
    expect(detailRes.body.credential).not.toHaveProperty('secret');
  });

  it('authenticates via X-API-Key, Authorization ApiKey, and Bearer ffk_..., enforcing scopes and wallet isolation', async () => {
    const readOnly = createApiCredential({
      walletAddress: walletA,
      name: 'Read Only',
      scopes: ['streams:read'],
    });
    const writerA = createApiCredential({
      walletAddress: walletA,
      name: 'Wallet A Writer',
      scopes: ['streams:write'],
    });
    const writerB = createApiCredential({
      walletAddress: walletB,
      name: 'Wallet B Writer',
      scopes: ['streams:write'],
    });

    // All three header formats work for reads.
    const viaHeader = await request(app)
      .get('/v1/protected/read')
      .set('X-API-Key', readOnly.secret);
    expect(viaHeader.status).toBe(200);
    expect(viaHeader.body).toMatchObject({
      wallet: walletA,
      authMethod: 'api_key',
    });

    const viaApiKeyScheme = await request(app)
      .get('/v1/protected/read')
      .set('Authorization', `ApiKey ${readOnly.secret}`);
    expect(viaApiKeyScheme.status).toBe(200);

    const viaBearerPrefix = await request(app)
      .get('/v1/protected/read')
      .set('Authorization', `Bearer ${readOnly.secret}`);
    expect(viaBearerPrefix.status).toBe(200);

    // Scope enforcement: read-only credential cannot invoke streams:write route.
    const insufficientScope = await request(app)
      .post('/v1/protected/write/101')
      .set('X-API-Key', readOnly.secret);
    expect(insufficientScope.status).toBe(403);
    expect(insufficientScope.body.error.code).toBe('INSUFFICIENT_SCOPE');
    expect(insufficientScope.body.error.details.missingScopes).toEqual([
      'streams:write',
    ]);

    // Owning wallet's write credential succeeds on own stream.
    const ownWrite = await request(app)
      .post('/v1/protected/write/101')
      .set('X-API-Key', writerA.secret);
    expect(ownWrite.status).toBe(200);

    // Cross-wallet isolation: Wallet B's write credential cannot touch Wallet A's stream.
    const crossWalletWrite = await request(app)
      .post('/v1/protected/write/101')
      .set('X-API-Key', writerB.secret);
    expect(crossWalletWrite.status).toBe(403);
  });

  it('enforces cross-wallet isolation on credential inventory, detail, rotation, revocation, and audit routes', async () => {
    const created = createApiCredential({
      walletAddress: walletA,
      name: 'Wallet A Secret',
      scopes: ['streams:read'],
    });
    const id = created.credential.id;

    const listB = await request(app)
      .get('/v1/credentials')
      .set('Authorization', `Bearer ${jwtB}`);
    expect(listB.status).toBe(200);
    expect(listB.body.credentials).toEqual([]);

    const getB = await request(app)
      .get(`/v1/credentials/${id}`)
      .set('Authorization', `Bearer ${jwtB}`);
    expect(getB.status).toBe(404);
    expect(getB.body.error.code).toBe('CREDENTIAL_NOT_FOUND');

    const rotateB = await request(app)
      .post(`/v1/credentials/${id}/rotate`)
      .set('Authorization', `Bearer ${jwtB}`)
      .send({});
    expect(rotateB.status).toBe(404);

    const deleteB = await request(app)
      .delete(`/v1/credentials/${id}`)
      .set('Authorization', `Bearer ${jwtB}`);
    expect(deleteB.status).toBe(404);

    const auditB = await request(app)
      .get(`/v1/credentials/${id}/audit`)
      .set('Authorization', `Bearer ${jwtB}`);
    expect(auditB.status).toBe(404);
  });

  it('prevents API credentials from managing credentials or accessing admin endpoints', async () => {
    vi.stubEnv('ADMIN_PUBLIC_KEY', walletA);
    const key = createApiCredential({
      walletAddress: walletA,
      name: 'Admin Wallet Integration Key',
      scopes: ['streams:read', 'streams:write'],
    });

    const selfManage = await request(app)
      .get('/v1/credentials')
      .set('X-API-Key', key.secret);
    expect(selfManage.status).toBe(403);
    expect(selfManage.body.error.code).toBe('WALLET_SESSION_REQUIRED');

    const adminAttempt = await request(app)
      .get('/v1/admin/check')
      .set('X-API-Key', key.secret);
    expect(adminAttempt.status).toBe(403);
    expect(adminAttempt.body.error.code).toBe('WALLET_SESSION_REQUIRED');

    // Wallet-signed JWT for admin wallet still succeeds.
    const adminWithJwt = await request(app)
      .get('/v1/admin/check')
      .set('Authorization', `Bearer ${jwtA}`);
    expect(adminWithJwt.status).toBe(200);
  });

  it('supports immediate rotation and bounded grace-period overlap rotation', async () => {
    const t0 = Date.parse('2026-11-24T00:00:00.000Z');
    const created = createApiCredential({
      walletAddress: walletA,
      name: 'Rotator',
      scopes: ['streams:read'],
      expiresInSeconds: 3600,
      now: t0,
    });

    // Rotate with a 300s overlap grace window.
    const rotated = rotateApiCredential({
      walletAddress: walletA,
      credentialId: created.credential.id,
      gracePeriodSeconds: 300,
      now: t0 + 10_000,
    });

    expect(rotated.secret).not.toBe(created.secret);
    expect(rotated.previousCredential.status).toBe('rotated');
    expect(rotated.credential.rotatedFromId).toBe(created.credential.id);

    // During grace window both old and new secrets verify.
    expect(
      verifyApiCredential(created.secret, { now: t0 + 100_000 }).ok,
    ).toBe(true);
    expect(
      verifyApiCredential(rotated.secret, { now: t0 + 100_000 }).ok,
    ).toBe(true);

    // After grace window expires, old secret fails with CREDENTIAL_ROTATED_EXPIRED.
    const afterGrace = verifyApiCredential(created.secret, {
      now: t0 + 320_000,
    });
    expect(afterGrace.ok).toBe(false);
    if (!afterGrace.ok) {
      expect(afterGrace.code).toBe('CREDENTIAL_ROTATED_EXPIRED');
    }
    expect(
      verifyApiCredential(rotated.secret, { now: t0 + 320_000 }).ok,
    ).toBe(true);

    // Immediate rotation (gracePeriodSeconds: 0) revokes previous secret immediately.
    const immediate = rotateApiCredential({
      walletAddress: walletA,
      credentialId: rotated.credential.id,
      gracePeriodSeconds: 0,
      now: t0 + 400_000,
    });
    const oldAfterImmediate = verifyApiCredential(rotated.secret, {
      now: t0 + 400_001,
    });
    expect(oldAfterImmediate.ok).toBe(false);
    if (!oldAfterImmediate.ok) {
      expect(oldAfterImmediate.code).toBe('CREDENTIAL_REVOKED');
    }
    expect(
      verifyApiCredential(immediate.secret, { now: t0 + 400_001 }).ok,
    ).toBe(true);

    // Cannot rotate an already-revoked credential.
    const rotateAgain = await request(app)
      .post(`/v1/credentials/${rotated.credential.id}/rotate`)
      .set('Authorization', `Bearer ${jwtA}`)
      .send({});
    expect(rotateAgain.status).toBe(409);
    expect(rotateAgain.body.error.code).toBe('CREDENTIAL_NOT_ROTATABLE');
  });

  it('enforces expiry, network scoping, revocation idempotency, input boundaries, and per-wallet quota', async () => {
    const t0 = Date.parse('2026-11-24T00:00:00.000Z');
    const shortLived = createApiCredential({
      walletAddress: walletA,
      name: 'Short TTL',
      scopes: ['streams:read'],
      expiresInSeconds: MIN_CREDENTIAL_TTL_SECONDS,
      network: 'testnet',
      now: t0,
    });

    // Network mismatch rejected.
    const wrongNet = verifyApiCredential(shortLived.secret, {
      expectedNetwork: 'mainnet',
      now: t0 + 1_000,
    });
    expect(wrongNet.ok).toBe(false);
    if (!wrongNet.ok) {
      expect(wrongNet.code).toBe('CREDENTIAL_NETWORK_MISMATCH');
    }

    // Expired credential rejected.
    const expired = verifyApiCredential(shortLived.secret, {
      expectedNetwork: 'testnet',
      now: t0 + MIN_CREDENTIAL_TTL_SECONDS * 1000,
    });
    expect(expired.ok).toBe(false);
    if (!expired.ok) {
      expect(expired.code).toBe('CREDENTIAL_EXPIRED');
    }

    // Invalid scopes & invalid TTL boundaries rejected with 400.
    const badScopeRes = await request(app)
      .post('/v1/credentials')
      .set('Authorization', `Bearer ${jwtA}`)
      .send({ name: 'Wildcard', scopes: ['*'] });
    expect(badScopeRes.status).toBe(400);
    expect(badScopeRes.body.error.code).toBe('INVALID_SCOPES');

    const badTtlRes = await request(app)
      .post('/v1/credentials')
      .set('Authorization', `Bearer ${jwtA}`)
      .send({
        name: 'Too Long',
        scopes: ['streams:read'],
        expiresInSeconds: MAX_CREDENTIAL_TTL_SECONDS + 1,
      });
    expect(badTtlRes.status).toBe(400);
    expect(badTtlRes.body.error.code).toBe('INVALID_EXPIRY');

    // Revocation is idempotent on retry.
    const rev1 = await request(app)
      .delete(`/v1/credentials/${shortLived.credential.id}`)
      .set('Authorization', `Bearer ${jwtA}`);
    expect(rev1.status).toBe(200);
    expect(rev1.body.revoked).toBe(true);
    expect(rev1.body.alreadyRevoked).toBe(false);

    const rev2 = await request(app)
      .delete(`/v1/credentials/${shortLived.credential.id}`)
      .set('Authorization', `Bearer ${jwtA}`);
    expect(rev2.status).toBe(200);
    expect(rev2.body.revoked).toBe(true);
    expect(rev2.body.alreadyRevoked).toBe(true);

    // Active credential quota enforcement.
    __apiCredentialTestUtils.clearAll();
    for (let i = 0; i < MAX_ACTIVE_CREDENTIALS_PER_WALLET; i += 1) {
      createApiCredential({
        walletAddress: walletA,
        name: `Key ${i + 1}`,
        scopes: ['streams:read'],
      });
    }
    const overQuota = await request(app)
      .post('/v1/credentials')
      .set('Authorization', `Bearer ${jwtA}`)
      .send({ name: 'One Too Many', scopes: ['streams:read'] });
    expect(overQuota.status).toBe(409);
    expect(overQuota.body.error.code).toBe('CREDENTIAL_LIMIT_EXCEEDED');
  });

  it('records sanitized audit trail for lifecycle, auth success, and scope denials without leaking secrets', async () => {
    const createdRes = await request(app)
      .post('/v1/credentials')
      .set('Authorization', `Bearer ${jwtA}`)
      .send({ name: 'Audited Key', scopes: ['streams:read'] });
    const id = createdRes.body.credential.id as string;
    const secret = createdRes.body.secret as string;

    await request(app).get('/v1/protected/read').set('X-API-Key', secret);
    await request(app).post('/v1/protected/write/101').set('X-API-Key', secret);
    await request(app)
      .delete(`/v1/credentials/${id}`)
      .set('Authorization', `Bearer ${jwtA}`);

    const auditRes = await request(app)
      .get(`/v1/credentials/${id}/audit`)
      .set('Authorization', `Bearer ${jwtA}`);

    expect(auditRes.status).toBe(200);
    const actions = (auditRes.body.events as Array<{ action: string }>).map(
      (e) => e.action,
    );
    expect(actions).toEqual(
      expect.arrayContaining([
        'credential.created',
        'credential.auth_succeeded',
        'credential.auth_failed',
        'credential.revoked',
      ]),
    );
    expect(JSON.stringify(auditRes.body)).not.toContain(secret);
  });
});
