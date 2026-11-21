import { beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { Keypair } from '@stellar/stellar-sdk';

const db = vi.hoisted(() => ({
  subscriptions: [] as Array<Record<string, unknown>>,
  webhookSubscription: {
    findMany: vi.fn(), deleteMany: vi.fn(), findFirst: vi.fn(), update: vi.fn(),
  },
  webhookDelivery: { findMany: vi.fn(), count: vi.fn() },
}));
vi.mock('../src/lib/prisma.js', () => ({ prisma: db }));

import webhookRoutes from '../src/routes/v1/webhook.routes.js';
import { signJwt } from '../src/middleware/auth.js';

const owner = Keypair.fromRawEd25519Seed(Buffer.alloc(32, 3)).publicKey();
const outsider = Keypair.fromRawEd25519Seed(Buffer.alloc(32, 4)).publicKey();
const roles = ['owner', 'admin', 'operator', 'viewer'] as const;
const app = express();
app.use(express.json());
app.use('/webhooks', webhookRoutes);
const token = (wallet: string, role: string) => {
  const now = Math.floor(Date.now() / 1000);
  return signJwt({ sub: wallet, role, iat: now, exp: now + 3600, iss: 'flowfi-api', aud: 'flowfi-api' });
};

beforeEach(() => {
  vi.clearAllMocks();
  db.subscriptions = [{ id: 'hook-1', userAddress: owner, targetUrl: 'https://example.test/hook', secretKey: 'secret', eventTypes: ['stream.created'], isActive: true }];
  db.webhookSubscription.findMany.mockImplementation(async ({ where }: { where: { userAddress: string } }) => db.subscriptions.filter((row) => row.userAddress === where.userAddress));
  db.webhookSubscription.findFirst.mockImplementation(async ({ where }: { where: { id: string; userAddress: string } }) => db.subscriptions.find((row) => row.id === where.id && row.userAddress === where.userAddress) ?? null);
  db.webhookSubscription.deleteMany.mockImplementation(async ({ where }: { where: { id: string; userAddress: string } }) => {
    const before = db.subscriptions.length;
    db.subscriptions = db.subscriptions.filter((row) => row.id !== where.id || row.userAddress !== where.userAddress);
    return { count: before - db.subscriptions.length };
  });
  db.webhookSubscription.update.mockResolvedValue({});
  db.webhookDelivery.findMany.mockResolvedValue([]);
  db.webhookDelivery.count.mockResolvedValue(0);
});

describe('webhook wallet isolation across role claims', () => {
  it.each(roles)('%s can list only the authenticated wallet’s hooks', async (role) => {
    const own = await request(app).get('/webhooks').set('Authorization', `Bearer ${token(owner, role)}`);
    const foreign = await request(app).get('/webhooks').set('Authorization', `Bearer ${token(outsider, role)}`);
    expect(own.status).toBe(200);
    expect(own.body.subscriptions).toHaveLength(1);
    expect(foreign.status).toBe(200);
    expect(foreign.body.subscriptions).toEqual([]);
  });

  it.each(roles)('%s cannot read deliveries or rotate another wallet’s secret', async (role) => {
    const auth = `Bearer ${token(outsider, role)}`;
    expect((await request(app).get('/webhooks/hook-1/deliveries').set('Authorization', auth)).status).toBe(400);
    expect((await request(app).post('/webhooks/hook-1/secret').set('Authorization', auth)).status).toBe(400);
    expect(db.webhookSubscription.update).not.toHaveBeenCalled();
  });

  it('rejects anonymous access and does not delete a foreign hook', async () => {
    expect((await request(app).get('/webhooks')).status).toBe(401);
    expect((await request(app).delete('/webhooks/hook-1').set('Authorization', `Bearer ${token(outsider, 'admin')}`)).status).toBe(204);
    expect(db.subscriptions).toHaveLength(1);
  });
});
