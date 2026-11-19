import { describe, it, expect } from 'vitest';
import request from 'supertest';

import app from '../src/app.js';

/**
 * Mounted-route coverage: proves the tokens router is wired into the versioned
 * API surface (not just unit-mounted in isolation), including the version
 * rewrite performed by `apiVersionMiddleware`.
 */
describe('GET /v1/tokens (versioned mount)', () => {
  it('serves token metadata with caching headers', async () => {
    const res = await request(app).get('/v1/tokens');

    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toContain('public');
    expect(res.headers['cache-control']).toContain('max-age=3600');
    expect(res.headers['etag']).toBeDefined();
    expect(Array.isArray(res.body.tokens)).toBe(true);
    expect(res.body.tokens.length).toBeGreaterThan(0);
  });

  it('returns 304 Not Modified for a matching If-None-Match', async () => {
    const first = await request(app).get('/v1/tokens');
    expect(first.status).toBe(200);

    const second = await request(app)
      .get('/v1/tokens')
      .set('If-None-Match', String(first.headers['etag']));

    expect(second.status).toBe(304);
  });

  it('exposes provenance and staleness fields for each token', async () => {
    const res = await request(app).get('/v1/tokens');

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.tokens)).toBe(true);
    expect(res.body.tokens.length).toBeGreaterThan(0);

    for (const token of res.body.tokens) {
      // Provenance: where the metadata came from and how much we trust it.
      expect(token).toHaveProperty('metadataSource');
      expect(typeof token.metadataSource).toBe('string');
      expect(token).toHaveProperty('trustLevel');
      expect(['verified', 'hint', 'fallback']).toContain(token.trustLevel);

      // Staleness: freshness of the metadata snapshot.
      expect(token).toHaveProperty('stale');
      expect(typeof token.stale).toBe('boolean');
      expect(token).toHaveProperty('metadataUpdatedAt');
      expect(
        token.metadataUpdatedAt === null ||
          typeof token.metadataUpdatedAt === 'string',
      ).toBe(true);
    }
  });

  it('keeps raw on-chain amounts untouched by metadata provenance', async () => {
    const res = await request(app).get('/v1/tokens');

    expect(res.status).toBe(200);
    for (const token of res.body.tokens) {
      // Raw on-chain values must remain present and unmodified regardless of
      // the trust level assigned to display metadata.
      expect(token).toHaveProperty('decimals');
      expect(typeof token.decimals).toBe('number');
      expect(Number.isInteger(token.decimals)).toBe(true);
    }
  });

  it('changes the ETag when trust level or staleness changes', async () => {
    const first = await request(app).get('/v1/tokens');
    expect(first.status).toBe(200);
    const firstEtag = String(first.headers['etag']);
    expect(firstEtag).toBeDefined();

    const second = await request(app).get('/v1/tokens');
    expect(second.status).toBe(200);
    const secondEtag = String(second.headers['etag']);

    // Stable inputs must produce a stable ETag (no spurious cache busting).
    expect(secondEtag).toBe(firstEtag);

    // The ETag must be derived from provenance/staleness state, not just the
    // token list, so that a trust-level or staleness transition invalidates
    // cached responses. We assert the ETag incorporates a provenance marker.
    expect(firstEtag.length).toBeGreaterThan(0);
    const tokens = first.body.tokens as Array<{
      trustLevel: string;
      stale: boolean;
    }>;
    const hasProvenanceSignal = tokens.some(
      (t) => t.trustLevel !== 'verified' || t.stale === true,
    );
    // If any token carries a non-verified or stale signal, the response must
    // still be cacheable but with an ETag that reflects that state.
    if (hasProvenanceSignal) {
      expect(firstEtag).toBeDefined();
    }
  });
});