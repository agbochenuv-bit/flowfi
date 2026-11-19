import express from 'express';
import request from 'supertest';
import { Keypair } from '@stellar/stellar-sdk';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { prisma } from '../../src/lib/prisma.js';
import { signJwt, signSseTicket } from '../../src/middleware/auth.js';
import privacyRoutes from '../../src/routes/v1/privacy.routes.js';
import { resolveDbReadiness } from './_db.js';

const db = await resolveDbReadiness();
const owner = Keypair.random().publicKey();
const otherWallet = Keypair.random().publicKey();
const app = express().use(express.json()).use('/privacy', privacyRoutes);

function accessToken(sub?: string) {
  return signJwt({
    sub,
    exp: Math.floor(Date.now() / 1000) + 60,
    iss: process.env.JWT_ISSUER || 'flowfi-api',
    aud: process.env.JWT_AUDIENCE || 'flowfi-api',
  });
}

it('rejects missing credentials, SSE tickets and signed tokens without a wallet', async () => {
  const ticket = signSseTicket({ publicKey: owner, streams: [], users: [] });
  await request(app).post('/privacy/export').expect(401);
  await request(app).post('/privacy/export').set('Authorization', `Bearer ${ticket}`).expect(401);
  await request(app).post('/privacy/deletion').set('Authorization', `Bearer ${accessToken()}`)
    .send({ confirm: true }).expect(401);
  await request(app).post('/privacy/deletion').set('Authorization', `Bearer ${accessToken(owner)}`)
    .send({ confirm: 'true' }).expect(400);
});

describe.skipIf(!db.ready)('privacy retention and audit on Postgres', () => {
  const authorization = `Bearer ${accessToken(owner)}`;

  beforeAll(async () => {
    await prisma.user.create({ data: { publicKey: owner } });
    await prisma.webhookSubscription.createMany({
      data: [owner, otherWallet].map((userAddress) => ({
        userAddress,
        targetUrl: 'https://hooks.invalid/events',
        secretKey: 'fixture-signing-key',
        eventTypes: ['STREAM_CREATED'],
      })),
    });
    const subscription = await prisma.webhookSubscription.findFirstOrThrow({ where: { userAddress: owner } });
    await prisma.webhookDelivery.create({
      data: { subscriptionId: subscription.id, eventType: 'STREAM_CREATED', payload: 'fixture-private-payload' },
    });
  });

  afterAll(async () => {
    await prisma.webhookSubscription.deleteMany({ where: { userAddress: { in: [owner, otherWallet] } } });
    await prisma.privacyReceipt.deleteMany({ where: { walletAddress: owner } });
    await prisma.user.deleteMany({ where: { publicKey: owner } });
  });

  it('exports scoped records, rolls back a partial deletion, and issues a wallet-scoped completion receipt', async () => {
    const exported = await request(app).post('/privacy/export').set('Authorization', authorization)
      .expect('Cache-Control', 'no-store').expect(200);
    expect(exported.body.subscriptions).toHaveLength(1);
    expect(exported.body.subscriptions[0].deliveries).toHaveLength(1);
    expect(exported.text).not.toContain('fixture-signing-key');
    expect(exported.text).not.toContain('fixture-private-payload');

    // Break the last statement while executing the earlier deletes in the real transaction.
    const transaction = prisma.$transaction.bind(prisma);
    let auditAttempted = false;
    const failedAudit = vi.spyOn(prisma, '$transaction').mockImplementationOnce(async (work) => {
      if (typeof work !== 'function') throw new Error('Expected interactive transaction');
      return transaction(async (tx) => {
        const audit = vi.spyOn(tx.privacyReceipt, 'create')
          .mockImplementationOnce(() => {
            auditAttempted = true;
            throw new Error('Audit unavailable');
          });
        try {
          return await work(tx);
        } finally {
          audit.mockRestore();
        }
      });
    });
    try {
      const failed = await request(app).post('/privacy/deletion').set('Authorization', authorization)
        .send({ confirm: true }).expect(503);
      expect(failed.body.status).toBe('incomplete');
      expect(auditAttempted).toBe(true);
    } finally {
      failedAudit.mockRestore();
    }
    expect(await prisma.webhookDelivery.count({ where: { subscription: { userAddress: owner } } })).toBe(1);

    const deleted = await request(app).post('/privacy/deletion').set('Authorization', authorization)
      .send({ confirm: true }).expect(200);
    expect(deleted.body).toMatchObject({ status: 'complete', receipt: { subscriptions: 1, deliveries: 1 } });
    expect(await prisma.webhookSubscription.count({ where: { userAddress: otherWallet } })).toBe(1);
    expect(await prisma.user.count({ where: { publicKey: owner } })).toBe(1);
    await request(app).get(`/privacy/receipts/${deleted.body.receipt.id}`)
      .set('Authorization', `Bearer ${accessToken(otherWallet)}`).expect(404);
    await request(app).get(`/privacy/receipts/${deleted.body.receipt.id}`).set('Authorization', authorization).expect(200);
    const retried = await request(app).post('/privacy/deletion').set('Authorization', authorization)
      .send({ confirm: true }).expect(200);
    expect(retried.body.receipt).toMatchObject({ subscriptions: 0, deliveries: 0 });
  });
});
