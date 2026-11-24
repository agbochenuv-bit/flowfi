import { describe, it, expect, vi, beforeEach } from 'vitest';
import express, { type Request, type Response } from 'express';
import request from 'supertest';

const { prismaMock, getLatestLedgerMock } = vi.hoisted(() => ({
  prismaMock: {
    indexerState: {
      findUnique: vi.fn(),
    },
    ledgerCheckpoint: {
      findFirst: vi.fn(),
    },
  },
  getLatestLedgerMock: vi.fn(),
}));

vi.mock('../src/lib/prisma.js', () => ({
  prisma: prismaMock,
  default: prismaMock,
}));

vi.mock('../src/services/sorobanService.js', () => ({
  getLatestLedger: getLatestLedgerMock,
}));

vi.mock('../src/logger.js', () => ({
  default: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

import {
  attachFreshnessHeaders,
  computeChainFreshness,
  evaluateLedgerFinality,
  getChainFreshnessMetadata,
} from '../src/services/freshness.service.js';

describe('Chain freshness and finality metadata (#231)', () => {
  const fixedNowMs = Date.parse('2026-11-24T04:00:00.000Z');

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('classifies fresh checkpoint-corroborated indexed state as finalized', () => {
    const metadata = computeChainFreshness({
      network: 'testnet',
      source: 'indexer',
      indexedLedger: 1000,
      verifiedCheckpointLedger: 1000,
      networkLedger: 1002,
      indexedAt: new Date(fixedNowMs - 5_000),
      staleThresholdSeconds: 30,
      maxLedgerLag: 6,
      nowMs: fixedNowMs,
    });

    expect(metadata).toMatchObject({
      network: 'testnet',
      source: 'indexer',
      freshness: 'fresh',
      stale: false,
      finality: 'finalized',
      indexedLedger: 1000,
      verifiedCheckpointLedger: 1000,
      networkLedger: 1002,
      ledgerLag: 2,
      ageSeconds: 5,
      degradedReason: null,
      recoveryHint: null,
    });
  });

  it('classifies fresh indexed state without verified checkpoint as indexed_unverified', () => {
    const metadata = computeChainFreshness({
      network: 'testnet',
      source: 'indexer',
      indexedLedger: 1000,
      verifiedCheckpointLedger: 998,
      networkLedger: 1001,
      indexedAt: new Date(fixedNowMs - 4_000),
      nowMs: fixedNowMs,
    });

    expect(metadata.freshness).toBe('fresh');
    expect(metadata.stale).toBe(false);
    expect(metadata.finality).toBe('indexed_unverified');
    expect(metadata.recoveryHint).toContain('verified ledger checkpoint');
  });

  it('marks indexed state stale when age or ledger lag exceeds configured bounds', () => {
    const staleByAge = computeChainFreshness({
      network: 'testnet',
      source: 'indexer',
      indexedLedger: 1000,
      verifiedCheckpointLedger: 1000,
      indexedAt: new Date(fixedNowMs - 45_000),
      staleThresholdSeconds: 30,
      nowMs: fixedNowMs,
    });

    expect(staleByAge.freshness).toBe('stale');
    expect(staleByAge.stale).toBe(true);
    expect(staleByAge.finality).toBe('stale');
    expect(staleByAge.degradedReason).toContain('INDEXER_AGE_EXCEEDED');
    expect(staleByAge.recoveryHint).toBeTruthy();

    const staleByLag = computeChainFreshness({
      network: 'testnet',
      source: 'indexer',
      indexedLedger: 1000,
      verifiedCheckpointLedger: 1000,
      networkLedger: 1020,
      indexedAt: new Date(fixedNowMs - 2_000),
      maxLedgerLag: 6,
      nowMs: fixedNowMs,
    });

    expect(staleByLag.freshness).toBe('stale');
    expect(staleByLag.stale).toBe(true);
    expect(staleByLag.ledgerLag).toBe(20);
    expect(staleByLag.degradedReason).toContain('INDEXER_LEDGER_LAG_EXCEEDED');
  });

  it('distinguishes cold-start unknown, degraded probe errors, and live chain reads', () => {
    const coldStart = computeChainFreshness({
      network: 'testnet',
      source: 'indexer',
      nowMs: fixedNowMs,
    });
    expect(coldStart.freshness).toBe('unknown');
    expect(coldStart.stale).toBe(true);
    expect(coldStart.finality).toBe('unknown');
    expect(coldStart.degradedReason).toBe('INDEXER_STATE_UNAVAILABLE');

    const degraded = computeChainFreshness({
      network: 'testnet',
      source: 'indexer',
      probeError: 'INDEXER_STATE_QUERY_FAILED',
      nowMs: fixedNowMs,
    });
    expect(degraded.freshness).toBe('degraded');
    expect(degraded.stale).toBe(true);
    expect(degraded.finality).toBe('unknown');
    expect(degraded.recoveryHint).toContain('Soroban RPC');

    const liveChain = computeChainFreshness({
      network: 'mainnet',
      source: 'chain',
      networkLedger: 5500,
      nowMs: fixedNowMs,
    });
    expect(liveChain.freshness).toBe('fresh');
    expect(liveChain.stale).toBe(false);
    expect(liveChain.finality).toBe('finalized');
  });

  it('evaluates per-ledger finality across finalized, unverified, pending, and reverted states', () => {
    const finalized = evaluateLedgerFinality({
      network: 'testnet',
      ledgerSequence: 500,
      verifiedCheckpointLedger: 502,
      networkLedger: 505,
      confirmationLedgers: 2,
      nowMs: fixedNowMs,
    });
    expect(finalized).toMatchObject({
      finality: 'finalized',
      confirmations: 6,
      verifiedByCheckpoint: true,
      reverted: false,
      recoveryHint: null,
    });

    const unverified = evaluateLedgerFinality({
      network: 'testnet',
      ledgerSequence: 505,
      verifiedCheckpointLedger: 500,
      networkLedger: 505,
      nowMs: fixedNowMs,
    });
    expect(unverified.finality).toBe('indexed_unverified');
    expect(unverified.verifiedByCheckpoint).toBe(false);

    const pending = evaluateLedgerFinality({
      network: 'testnet',
      ledgerSequence: null,
      nowMs: fixedNowMs,
    });
    expect(pending.finality).toBe('pending');
    expect(pending.recoveryHint).toBeTruthy();

    const reverted = evaluateLedgerFinality({
      network: 'testnet',
      ledgerSequence: 501,
      verifiedCheckpointLedger: 500,
      reverted: true,
      nowMs: fixedNowMs,
    });
    expect(reverted.finality).toBe('stale');
    expect(reverted.reverted).toBe(true);
    expect(reverted.recoveryHint).toContain('reverted');
  });

  it('degrades gracefully when DB/RPC probes fail and recovers on retry', async () => {
    prismaMock.indexerState.findUnique.mockRejectedValueOnce(
      new Error('db timeout'),
    );
    prismaMock.ledgerCheckpoint.findFirst.mockResolvedValueOnce(null);
    getLatestLedgerMock.mockRejectedValueOnce(new Error('rpc unreachable'));

    const degraded = await getChainFreshnessMetadata({
      includeNetworkTip: true,
      nowMs: fixedNowMs,
    });
    expect(degraded.freshness).toBe('degraded');
    expect(degraded.stale).toBe(true);
    expect(degraded.degradedReason).toContain('INDEXER_STATE_QUERY_FAILED');
    expect(degraded.degradedReason).toContain('NETWORK_TIP_QUERY_FAILED');

    // Retry after DB & RPC recover.
    prismaMock.indexerState.findUnique.mockResolvedValueOnce({
      id: 'singleton',
      lastLedger: 2000,
      updatedAt: new Date(fixedNowMs - 3_000),
    });
    prismaMock.ledgerCheckpoint.findFirst.mockResolvedValueOnce({
      ledgerSequence: 2000,
      processedAt: new Date(fixedNowMs - 3_000),
      isReverted: false,
    });
    getLatestLedgerMock.mockResolvedValueOnce(2001);

    const recovered = await getChainFreshnessMetadata({
      includeNetworkTip: true,
      nowMs: fixedNowMs,
    });
    expect(recovered.freshness).toBe('fresh');
    expect(recovered.finality).toBe('finalized');
    expect(recovered.ledgerLag).toBe(1);
  });

  it('attaches X-Chain-* HTTP headers and safely handles partial mock responses', async () => {
    const partialRes = {} as Response;
    expect(() =>
      attachFreshnessHeaders(
        partialRes,
        computeChainFreshness({
          indexedLedger: 10,
          verifiedCheckpointLedger: 10,
          indexedAt: new Date(fixedNowMs),
          nowMs: fixedNowMs,
        }),
      ),
    ).not.toThrow();

    prismaMock.indexerState.findUnique.mockResolvedValue({
      id: 'singleton',
      lastLedger: 900,
      updatedAt: new Date(),
    });
    prismaMock.ledgerCheckpoint.findFirst.mockResolvedValue({
      ledgerSequence: 900,
      processedAt: new Date(),
      isReverted: false,
    });
    getLatestLedgerMock.mockResolvedValue(902);

    const app = express();
    app.get('/v1/streams/freshness', async (_req: Request, res: Response) => {
      const metadata = await getChainFreshnessMetadata({
        includeNetworkTip: true,
      });
      attachFreshnessHeaders(res, metadata);
      res.status(200).json(metadata);
    });

    const res = await request(app).get('/v1/streams/freshness');
    expect(res.status).toBe(200);
    expect(res.headers['x-chain-network']).toBe('testnet');
    expect(res.headers['x-chain-data-source']).toBe('indexer');
    expect(res.headers['x-chain-freshness']).toBe('fresh');
    expect(res.headers['x-chain-finality']).toBe('finalized');
    expect(res.headers['x-chain-indexed-ledger']).toBe('900');
    expect(res.headers['x-chain-verified-checkpoint-ledger']).toBe('900');
    expect(res.headers['x-chain-network-ledger']).toBe('902');
    expect(res.headers['x-chain-ledger-lag']).toBe('2');
  });
});
