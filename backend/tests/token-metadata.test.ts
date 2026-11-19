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
  getTokenMetadata,
  isBlockedToken,
  blockToken,
  unblockToken,
  listBlockedTokens,
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

  it('returns undefined for unknown token metadata', () => {
    expect(getTokenMetadata('NOPE')).toBeUndefined();
  });

  it('preserves raw identifiers for unknown metadata lookups', () => {
    const raw = 'GABCDEFGHIJKLMNOPQRSTUVWXYZ234567ABCDEFGHIJKLMNOPQRSTUVWXYZ2345';
    expect(getTokenMetadata(raw)).toBeUndefined();
    // The raw identifier must not be mutated or hidden by the lookup.
    expect(raw).toBe(
      'GABCDEFGHIJKLMNOPQRSTUVWXYZ234567ABCDEFGHIJKLMNOPQRSTUVWXYZ2345',
    );
  });

  it('records provenance and network-specific addresses', () => {
    upsertTokenMetadata({
      symbol: 'USDC',
      name: 'USD Coin',
      decimals: 7,
      contractAddress: 'CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA',
      type: 'credit_alphanum4',
      verified: true,
      provenance: 'stellar-official',
      network: 'mainnet',
      addresses: {
        mainnet: 'CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA',
        testnet: 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5',
      },
    });

    const usdc = getTokenMetadata('USDC');
    expect(usdc).toMatchObject({
      provenance: 'stellar-official',
      network: 'mainnet',
    });
    expect(usdc?.addresses?.mainnet).toBe(
      'CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA',
    );
    expect(usdc?.addresses?.testnet).toBe(
      'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5',
    );
  });

  it('blocks and unblocks assets while keeping raw identifiers visible', () => {
    const address = 'CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA';
    upsertTokenMetadata({
      symbol: 'USDC',
      name: 'USD Coin',
      decimals: 7,
      contractAddress: address,
      type: 'credit_alphanum4',
      verified: true,
    });

    expect(isBlockedToken('USDC')).toBe(false);

    blockToken('USDC', 'sanctions-list');
    expect(isBlockedToken('USDC')).toBe(true);
    expect(isBlockedToken('usdc')).toBe(true);
    expect(listBlockedTokens()).toEqual([
      expect.objectContaining({ symbol: 'USDC', reason: 'sanctions-list' }),
    ]);

    // The raw identifier stays available even when the asset is blocked.
    const blocked = getTokenMetadata('USDC');
    expect(blocked?.contractAddress).toBe(address);
    expect(blocked?.blocked).toBe(true);

    unblockToken('USDC');
    expect(isBlockedToken('USDC')).toBe(false);
    expect(listBlockedTokens()).toEqual([]);
  });

  it('treats unknown assets as unblocked', () => {
    expect(isBlockedToken('UNKNOWN')).toBe(false);
  });
});

describe('GET /v1/tokens risk and verification details', () => {
  beforeEach(() => resetTokenMetadata());

  it('exposes provenance and network-specific addresses', async () => {
    upsertTokenMetadata({
      symbol: 'USDC',
      name: 'USD Coin',
      decimals: 7,
      contractAddress: 'CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA',
      type: 'credit_alphanum4',
      verified: true,
      provenance: 'stellar-official',
      network: 'mainnet',
      addresses: {
        mainnet: 'CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA',
        testnet: 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5',
      },
    });

    const res = await request(mountTokensApp()).get('/v1/tokens');
    expect(res.status).toBe(200);

    const usdc = res.body.tokens.find((t: { symbol: string }) => t.symbol === 'USDC');
    expect(usdc).toMatchObject({
      symbol: 'USDC',
      verified: true,
      provenance: 'stellar-official',
      network: 'mainnet',
    });
    expect(usdc.addresses.mainnet).toBe(
      'CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA',
    );
    expect(usdc.addresses.testnet).toBe(
      'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5',
    );
  });

  it('flags blocked assets without hiding raw identifiers', async () => {
    const address = 'CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA';
    upsertTokenMetadata({
      symbol: 'USDC',
      name: 'USD Coin',
      decimals: 7,
      contractAddress: address,
      type: 'credit_alphanum4',
      verified: true,
    });
    blockToken('USDC', 'sanctions-list');

    const res = await request(mountTokensApp()).get('/v1/tokens');
    expect(res.status).toBe(200);

    const usdc = res.body.tokens.find((t: { symbol: string }) => t.symbol === 'USDC');
    expect(usdc.blocked).toBe(true);
    expect(usdc.blockReason).toBe('sanctions-list');
    expect(usdc.contractAddress).toBe(address);
  });

  it('keeps backward-compatible fields and caching headers', async () => {
    const res = await request(mountTokensApp()).get('/v1/tokens');

    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe(TOKEN_CACHE_CONTROL);
    expect(res.headers['etag']).toBeDefined();

    for (const token of res.body.tokens) {
      expect(token).toEqual(
        expect.objectContaining({
          symbol: expect.any(String),
          name: expect.any(String),
          decimals: expect.any(Number),
          type: expect.any(String),
          verified: expect.any(Boolean),
        }),
      );
    }
  });

  it('invalidates the cache when a token is blocked', async () => {
    const first = await request(mountTokensApp()).get('/v1/tokens');
    const oldEtag = String(first.headers['etag']);

    blockToken('USDC', 'sanctions-list');

    const afterBlock = await request(mountTokensApp()).get('/v1/tokens');
    expect(afterBlock.headers['etag']).not.toBe(oldEtag);

    const conditional = await request(mountTokensApp())
      .get('/v1/tokens')
      .set('If-None-Match', oldEtag);
    expect(conditional.status).toBe(200);
    const usdc = conditional.body.tokens.find(
      (t: { symbol: string }) => t.symbol === 'USDC',
    );
    expect(usdc.blocked).toBe(true);
  });
});
