import { Router, type Request, type Response } from 'express';
import { createHash } from 'node:crypto';
import {
  getTokenMetadataUpdatedAt,
  listVerifiedTokens,
  type TokenMetadataList,
} from '../../lib/token-metadata.js';

const router = Router();

/**
 * Verified token metadata is effectively static, so it is safe to let browsers
 * and CDNs reuse it for an hour while serving stale content for a day in the
 * background (`stale-while-revalidate`). The `ETag` below lets a client skip
 * the body entirely with a conditional `If-None-Match` request.
 */
export const TOKEN_CACHE_CONTROL =
  'public, max-age=3600, stale-while-revalidate=86400';

function buildPayload(): TokenMetadataList {
  return {
    tokens: listVerifiedTokens(),
    updatedAt: getTokenMetadataUpdatedAt(),
  };
}

/**
 * Strong ETag derived from the serialized payload. Anything that changes the
 * metadata (or its version marker) changes the hash, so a client revalidating
 * with a stale ETag gets fresh content — i.e. updates invalidate the cache.
 *
 * The payload includes per-token provenance (`source`, `trustLevel`) and
 * staleness (`stale`, `ageSeconds`) fields, so a change in where a token's
 * metadata came from, or in its freshness, also changes the ETag.
 */
export function computeTokensEtag(body: string): string {
  const hash = createHash('sha1').update(body).digest('base64url');
  return `"${hash}"`;
}

/** RFC 7232 `If-None-Match` matching, including `*` and weak validators. */
export function etagMatches(ifNoneMatch: string | undefined, etag: string): boolean {
  if (!ifNoneMatch) return false;
  const header = ifNoneMatch.trim();
  if (header === '*') return true;

  return header
    .split(',')
    .map((candidate) => candidate.trim().replace(/^W\//, ''))
    .some((candidate) => candidate === etag);
}

/**
 * @openapi
 * /v1/tokens:
 *   get:
 *     tags:
 *       - Tokens
 *     summary: List verified token metadata
 *     description: |
 *       Returns symbol, name, decimals, contract address and icon for every
 *       verified Stellar asset, together with provenance and staleness
 *       information so clients can distinguish verified data from hints.
 *
 *       **Trust levels** (`trustLevel`):
 *       - `verified` — metadata comes from the curated verified registry and
 *         is safe to display as authoritative.
 *       - `onchain` — metadata was read from the on-chain contract (e.g.
 *         `decimals()` / `name()`); authoritative for on-chain values but not
 *         curated for display.
 *       - `hint` — metadata is a best-effort fallback (cached or inferred)
 *         and MUST be treated as a display hint, not authoritative.
 *       - `unknown` — no usable metadata source was available; clients should
 *         fall back to the raw contract address and default decimals.
 *
 *       **Provenance** (`source`): identifies where the metadata came from,
 *       e.g. `verified-registry`, `onchain`, `cache`, or `fallback`.
 *
 *       **Staleness** (`stale`, `ageSeconds`, `updatedAt`): `stale` is `true`
 *       when the metadata is older than the freshness window; `ageSeconds` is
 *       the age of the underlying source at response time. Stale or malformed
 *       sources degrade the trust level but never alter raw on-chain amounts —
 *       `decimals` is only used for display formatting and callers must keep
 *       using the raw integer amounts returned by balance endpoints.
 *
 *       The response carries an `ETag` and a `Cache-Control` header; clients
 *       should revalidate with `If-None-Match` and accept a
 *       `304 Not Modified` while the metadata (including provenance and
 *       staleness) is unchanged.
 *     responses:
 *       200:
 *         description: Verified token metadata with provenance and staleness
 *         headers:
 *           Cache-Control:
 *             schema:
 *               type: string
 *             description: public, max-age=3600, stale-while-revalidate=86400
 *           ETag:
 *             schema:
 *               type: string
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 tokens:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       symbol:
 *                         type: string
 *                       name:
 *                         type: string
 *                       decimals:
 *                         type: integer
 *                       address:
 *                         type: string
 *                       icon:
 *                         type: string
 *                         nullable: true
 *                       source:
 *                         type: string
 *                         description: Where the metadata came from (e.g. verified-registry, onchain, cache, fallback).
 *                       trustLevel:
 *                         type: string
 *                         enum: [verified, onchain, hint, unknown]
 *                         description: How much the metadata can be trusted.
 *                       stale:
 *                         type: boolean
 *                         description: True when the metadata is older than the freshness window.
 *                       ageSeconds:
 *                         type: integer
 *                         nullable: true
 *                         description: Age of the underlying metadata source in seconds, when known.
 *                       updatedAt:
 *                         type: string
 *                         format: date-time
 *                         nullable: true
 *                         description: When the underlying metadata source was last refreshed.
 *                 updatedAt:
 *                   type: string
 *                   format: date-time
 *       304:
 *         description: Not Modified - the caller's cached copy is still current
 */
router.get('/', (req: Request, res: Response) => {
  const body = JSON.stringify(buildPayload());
  const etag = computeTokensEtag(body);

  res.setHeader('Cache-Control', TOKEN_CACHE_CONTROL);
  res.setHeader('ETag', etag);

  if (etagMatches(req.headers['if-none-match'], etag)) {
    // 304 must not carry a body. Repeated headers are required so an
    // intermediary does not strip the cache metadata from the 304.
    res.status(304).end();
    return;
  }

  res.status(200).type('application/json').send(body);
});

export default router;