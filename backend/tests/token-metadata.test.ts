import { describe, it, expect, beforeEach, vi } from 'vitest';
import express from 'express';
import request from 'supertest';

vi.mock('../src/logger.js', () => ({
  default: { error: vi.fn(), info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

import {
  resetTokenMetadata,
  upsertTokenMetadata,
  listVerifiedTokens,
  resolveTokenMetadata,
  TOKEN_METADATA_STALE_AFTER_MS,
} from '../src/lib/token-metadata.js';
import tokenRoutes, { TOKEN_CACHE_CONTROL } from '../src/routes/v1/token.routes.js';

function mountTokensApp(): express.Express {
  const app = express();
  app.use('/v1/tokens', tokenRoutes);
  return app;
}

describe('GET /v1/tokens', () => {
  beforeEach(() => {
    resetTokenMetadata();
  });

  it('returns verified token metadata', async () => {
    const res = await request(mountTokensApp()).get('/v1/tokens');

    expect(res.status).toBe(200);
    expect(res.body.tokens).toHaveLength(3);
    const symbols = res.body.tokens.map((t: { symbol: string }) => t.symbol);
    expect(symbols).toEqual(['EURC', 'USDC', 'XLM']);

    const xlm = res.body.tokens.find((t: { symbol: string }) => t.symbol === 'XLM');
    expect(xlm).toMatchObject({
      symbol: 'XLM',
      name: 'Stellar Lumens',
      decimals: 7,
      type: 'native',
      verified: true,
    });
  });

  it('sends a Cache-Control header that lets clients reuse the response', async () => {
    const res = await request(mountTokensApp()).get('/v1/tokens');

    expect(res.headers['cache-control']).toBe(TOKEN_CACHE_CONTROL);
    expect(res.headers['cache-control']).toContain('public');
    expect(res.headers['cache-control']).toContain('max-age=3600');
    expect(res.headers['cache-control']).toContain('stale-while-revalidate=86400');
  });

  it('sends a strong ETag and answers a matching If-None-Match with 304', async () => {
    const first = await request(mountTokensApp()).get('/v1/tokens');
    const etag = String(first.headers['etag']);
    expect(etag).toMatch(/^"[^"]+"$/);

    const second = await request(mountTokensApp())
      .get('/v1/tokens')
      .set('If-None-Match', etag);

    expect(second.status).toBe(304);
    expect(second.text).toBe('');
    expect(second.headers['etag']).toBe(etag);
    expect(second.headers['cache-control']).toBe(TOKEN_CACHE_CONTROL);
  });

  it('treats If-None-Match: * as a match', async () => {
    const res = await request(mountTokensApp()).get('/v1/tokens').set('If-None-Match', '*');
    expect(res.status).toBe(304);
  });

  it('tolerates a weak or list-valued If-None-Match header', async () => {
    const first = await request(mountTokensApp()).get('/v1/tokens');
    const etag = String(first.headers['etag']);

    const weak = await request(mountTokensApp())
      .get('/v1/tokens')
      .set('If-None-Match', `W/${etag}`);
    expect(weak.status).toBe(304);

    const list = await request(mountTokensApp())
      .get('/v1/tokens')
      .set('If-None-Match', `"other-tag", ${etag}`);
    expect(list.status).toBe(304);
  });

  it('returns the full body for a stale ETag', async () => {
    const res = await request(mountTokensApp())
      .get('/v1/tokens')
      .set('If-None-Match', '"stale-value"');

    expect(res.status).toBe(200);
    expect(res.body.tokens).toHaveLength(3);
  });

  it('invalidates the cache when token metadata changes', async () => {
    const first = await request(mountTokensApp()).get('/v1/tokens');
    const oldEtag = String(first.headers['etag']);

    upsertTokenMetadata({
      symbol: 'USDC',
      name: 'USD Coin (updated)',
      decimals: 7,
      contractAddress: 'CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA',
      type: 'credit_alphanum4',
      verified: true,
    });

    const afterUpdate = await request(mountTokensApp()).get('/v1/tokens');
    expect(afterUpdate.headers['etag']).not.toBe(oldEtag);

    // A client revalidating with the old ETag must now receive fresh content.
    const conditional = await request(mountTokensApp())
      .get('/v1/tokens')
      .set('If-None-Match', oldEtag);
    expect(conditional.status).toBe(200);
    const usdc = conditional.body.tokens.find(
      (t: { symbol: string }) => t.symbol === 'USDC',
    );
    expect(usdc.name).toBe('USD Coin (updated)');
  });
});

describe('token metadata store', () => {
  beforeEach(() => resetTokenMetadata());

  it('lists tokens ordered by symbol', () => {
    expect(listVerifiedTokens().map((t) => t.symbol)).toEqual(['EURC', 'USDC', 'XLM']);
  });

  it('upserts case-insensitively and normalises the symbol', () => {
    upsertTokenMetadata({
      symbol: 'usdc',
      name: 'USD Coin',
      decimals: 7,
      contractAddress: 'CUSD',
      type: 'credit_alphanum4',
      verified: true,
    });

    expect(listVerifiedTokens().find((t) => t.symbol === 'USDC')).toBeDefined();
    expect(listVerifiedTokens().filter((t) => t.symbol === 'USDC')).toHaveLength(1);
  });
});

describe('token metadata provenance and staleness', () => {
  const RAW_AMOUNT = '12345678901234567890';

  beforeEach(() => resetTokenMetadata());

  it('reports a verified source for curated metadata', () => {
    const resolved = resolveTokenMetadata('USDC', { now: Date.now() });

    expect(resolved).not.toBeNull();
    expect(resolved!.trustLevel).toBe('verified');
    expect(resolved!.source).toBe('curated');
    expect(resolved!.stale).toBe(false);
    expect(resolved!.name).toBe('USD Coin');
    expect(resolved!.decimals).toBe(7);
  });

  it('reports a cached source when metadata comes from the cache layer', () => {
    const now = Date.now();
    upsertTokenMetadata({
      symbol: 'USDC',
      name: 'USD Coin',
      decimals: 7,
      contractAddress: 'CUSD',
      type: 'credit_alphanum4',
      verified: true,
      source: 'cache',
      updatedAt: now,
    });

    const resolved = resolveTokenMetadata('USDC', { now });
    expect(resolved!.trustLevel).toBe('cached');
    expect(resolved!.source).toBe('cache');
    expect(resolved!.stale).toBe(false);
  });

  it('reports a fallback source with hint trust level', () => {
    const resolved = resolveTokenMetadata('UNKNOWN', {
      now: Date.now(),
      fallback: { name: 'Unknown Token', decimals: 7 },
    });

    expect(resolved).not.toBeNull();
    expect(resolved!.trustLevel).toBe('hint');
    expect(resolved!.source).toBe('fallback');
    expect(resolved!.name).toBe('Unknown Token');
    expect(resolved!.decimals).toBe(7);
  });

  it('returns null when no metadata source is available and no fallback is given', () => {
    expect(resolveTokenMetadata('UNKNOWN', { now: Date.now() })).toBeNull();
  });

  it('rejects malformed metadata and falls back without touching raw amounts', () => {
    upsertTokenMetadata({
      symbol: 'BAD',
      name: '',
      decimals: -1,
      contractAddress: 'CBAD',
      type: 'credit_alphanum4',
      verified: true,
    });

    const resolved = resolveTokenMetadata('BAD', {
      now: Date.now(),
      fallback: { name: 'BAD', decimals: 7 },
    });

    expect(resolved!.trustLevel).toBe('hint');
    expect(resolved!.source).toBe('fallback');
    expect(resolved!.decimals).toBe(7);
    expect(RAW_AMOUNT).toBe('12345678901234567890');
  });

  it('marks metadata stale exactly at the threshold boundary', () => {
    const now = Date.now();
    upsertTokenMetadata({
      symbol: 'USDC',
      name: 'USD Coin',
      decimals: 7,
      contractAddress: 'CUSD',
      type: 'credit_alphanum4',
      verified: true,
      source: 'curated',
      updatedAt: now - TOKEN_METADATA_STALE_AFTER_MS,
    });

    const atBoundary = resolveTokenMetadata('USDC', { now });
    expect(atBoundary!.stale).toBe(true);
    expect(atBoundary!.trustLevel).toBe('verified');

    upsertTokenMetadata({
      symbol: 'USDC',
      name: 'USD Coin',
      decimals: 7,
      contractAddress: 'CUSD',
      type: 'credit_alphanum4',
      verified: true,
      source: 'curated',
      updatedAt: now - TOKEN_METADATA_STALE_AFTER_MS + 1,
    });

    const justFresh = resolveTokenMetadata('USDC', { now });
    expect(justFresh!.stale).toBe(false);
  });

  it('keeps raw on-chain amounts unchanged regardless of metadata trust', () => {
    const verified = resolveTokenMetadata('USDC', { now: Date.now() });
    const fallback = resolveTokenMetadata('UNKNOWN', {
      now: Date.now(),
      fallback: { name: 'Unknown', decimals: 7 },
    });

    expect(verified!.trustLevel).toBe('verified');
    expect(fallback!.trustLevel).toBe('hint');
    expect(RAW_AMOUNT).toBe('12345678901234567890');
  });
});
