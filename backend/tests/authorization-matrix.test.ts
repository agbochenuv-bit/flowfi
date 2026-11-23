import { describe, expect, it, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { Keypair } from '@stellar/stellar-sdk';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { requireAuth, requireStreamOwnership, setStreamOwnerResolver, signJwt } from '../src/middleware/auth.js';

type Access = 'public' | 'wallet' | 'platform-admin';
const routeFiles: Record<string, string> = {
  'admin.routes.ts': '/admin',
  'analytics.routes.ts': '/analytics',
  'auth.routes.ts': '/auth',
  'events.routes.ts': '/events',
  'stream.routes.ts': '/streams',
  'token.routes.ts': '/tokens',
  'user.routes.ts': '/users',
  'webhook.routes.ts': '/webhooks',
};

// Every concrete v1 route gets an explicit expectation. Adding a route or a
// route file without updating this inventory fails the test before release.
const expected: Record<string, Access> = Object.fromEntries([
  ...['GET /metrics', 'GET /indexer/status', 'POST /indexer/reset', 'POST /indexer/replay',
    'GET /indexer/dead-letter', 'POST /indexer/dead-letter/replay-all',
    'POST /indexer/dead-letter/:id/replay', 'DELETE /indexer/dead-letter/:id',
    'POST /indexer/backfill', 'GET /indexer/backfill', 'GET /indexer/backfill/:id',
    'POST /indexer/backfill/:id/pause', 'POST /indexer/backfill/:id/resume',
    'POST /indexer/backfill/:id/cancel'].map((route) => [`/admin ${route}`, 'platform-admin']),
  ...['GET /tvl', 'GET /historical', 'GET /defillama'].map((route) => [`/analytics ${route}`, 'public']),
  ...['POST /challenge', 'POST /verify'].map((route) => [`/auth ${route}`, 'public']),
  ['/events POST /ticket', 'wallet'], ['/events GET /subscribe', 'wallet'],
  ...['GET /', 'POST /simulate', 'GET /users/:address/summary', 'GET /:streamId',
    'GET /:streamId/events', 'GET /:streamId/claimable'].map((route) => [`/streams ${route}`, 'public']),
  ...['POST /', 'POST /:streamId/top-up', 'POST /:streamId/pause',
    'POST /:streamId/resume', 'POST /:streamId/cancel', 'POST /:streamId/withdraw']
    .map((route) => [`/streams ${route}`, 'wallet']),
  ['/tokens GET /', 'public'], ['/users GET /:address/streams/summary', 'wallet'],
  ...['GET /', 'POST /', 'PATCH /:id', 'DELETE /:id', 'GET /:id/deliveries',
    'POST /:id/secret', 'POST /:id/test'].map((route) => [`/webhooks ${route}`, 'wallet']),
] as [string, Access][]);

function registeredRoutes(): string[] {
  const dir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src/routes/v1');
  const files = readdirSync(dir).filter((file) => file.endsWith('.routes.ts')).sort();
  expect(files).toEqual(Object.keys(routeFiles).sort());
  const routes: string[] = [];
  for (const file of files) {
    const source = readFileSync(path.join(dir, file), 'utf8');
    const calls = [...source.matchAll(/router\.(get|post|put|patch|delete)\s*\(/g)];
    const literals = [...source.matchAll(/router\.(get|post|put|patch|delete)\s*\(\s*(['"])(.*?)\2/g)];
    expect(literals.length).toBe(calls.length); // Reject dynamic paths until explicitly reviewed.
    for (const match of literals) {
      routes.push(`${routeFiles[file]} ${match[1]!.toUpperCase()} ${match[3]}`);
    }
  }
  return routes.sort();
}

describe('authorization route inventory', () => {
  it('requires an expectation for every registered route', () => {
    expect(registeredRoutes()).toEqual(Object.keys(expected).sort());
  });
});

const personal = Keypair.fromRawEd25519Seed(Buffer.alloc(32, 1)).publicKey();
const stranger = Keypair.fromRawEd25519Seed(Buffer.alloc(32, 2)).publicKey();
const roles = ['owner', 'admin', 'operator', 'viewer'] as const;
const jwt = (wallet: string, role: string) => {
  const now = Math.floor(Date.now() / 1000);
  return signJwt({ sub: wallet, role, iat: now, exp: now + 3600, iss: 'flowfi-api', aud: 'flowfi-api' });
};

describe('wallet ownership remains isolated from organization role claims', () => {
  const app = express();
  app.get('/streams/:id', requireAuth, requireStreamOwnership('id'), (_req, res) => res.sendStatus(204));
  beforeEach(() => setStreamOwnerResolver((id) => id === '42' ? personal : null));

  it.each(roles)('%s can access a stream only with the owning wallet', async (role) => {
    const own = await request(app).get('/streams/42').set('Authorization', `Bearer ${jwt(personal, role)}`);
    const foreign = await request(app).get('/streams/42').set('Authorization', `Bearer ${jwt(stranger, role)}`);
    expect(own.status).toBe(204);
    expect(foreign.status).toBe(403);
  });

  it('rejects anonymous and missing-stream requests', async () => {
    expect((await request(app).get('/streams/42')).status).toBe(401);
    expect((await request(app).get('/streams/999').set('Authorization', `Bearer ${jwt(personal, 'owner')}`)).status).toBe(404);
  });
});
