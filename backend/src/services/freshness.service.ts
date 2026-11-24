import type { Response } from 'express';
import { prisma } from '../lib/prisma.js';
import { INDEXER_STATE_ID } from '../lib/indexer-state.js';
import {
  getConfiguredStellarNetwork,
  type StellarNetworkId,
} from '../lib/stellar-network.js';
import { getLatestLedger } from './sorobanService.js';
import logger from '../logger.js';

/**
 * Chain freshness and finality metadata service (issue #231).
 *
 * Read surfaces must distinguish between:
 *  - live chain state read directly from Soroban RPC (`source: "chain"`),
 *  - indexed projection corroborated by a verified `LedgerCheckpoint`
 *    (`finality: "finalized"`),
 *  - indexed projection whose checkpoint has not yet been verified
 *    (`finality: "indexed_unverified"`),
 *  - lagging / stale projections (`freshness: "stale"`, `finality: "stale"`),
 *  - degraded or unknown freshness when indexer state or RPC cannot be probed
 *    (`freshness: "degraded" | "unknown"` with explicit `degradedReason` and
 *    `recoveryHint`).
 */

export type DataSource = 'indexer' | 'chain' | 'hybrid' | 'unknown';

export type FreshnessState = 'fresh' | 'stale' | 'degraded' | 'unknown';

export type FinalityStatus =
  | 'finalized'
  | 'indexed_unverified'
  | 'pending'
  | 'stale'
  | 'unknown';

export interface ChainFreshnessMetadata {
  network: StellarNetworkId;
  source: DataSource;
  freshness: FreshnessState;
  stale: boolean;
  finality: FinalityStatus;
  indexedLedger: number | null;
  verifiedCheckpointLedger: number | null;
  networkLedger: number | null;
  ledgerLag: number | null;
  indexedAt: string | null;
  ageSeconds: number | null;
  staleThresholdSeconds: number;
  maxLedgerLag: number;
  evaluatedAt: string;
  degradedReason: string | null;
  recoveryHint: string | null;
}

export interface TransactionFinalityMetadata {
  network: StellarNetworkId;
  ledgerSequence: number | null;
  finality: FinalityStatus;
  confirmations: number | null;
  verifiedByCheckpoint: boolean;
  reverted: boolean;
  evaluatedAt: string;
  recoveryHint: string | null;
}

export interface ComputeFreshnessInput {
  network?: StellarNetworkId | undefined;
  source?: DataSource | undefined;
  indexedLedger?: number | null | undefined;
  verifiedCheckpointLedger?: number | null | undefined;
  networkLedger?: number | null | undefined;
  indexedAt?: Date | string | null | undefined;
  staleThresholdSeconds?: number | undefined;
  maxLedgerLag?: number | undefined;
  nowMs?: number | undefined;
  probeError?: string | null | undefined;
  recordUpdatedAt?: Date | string | null | undefined;
}

export interface EvaluateLedgerFinalityInput {
  network?: StellarNetworkId | undefined;
  ledgerSequence: number | null;
  verifiedCheckpointLedger?: number | null | undefined;
  networkLedger?: number | null | undefined;
  reverted?: boolean | undefined;
  confirmationLedgers?: number | undefined;
  nowMs?: number | undefined;
}

export interface GetChainFreshnessOptions {
  source?: DataSource | undefined;
  includeNetworkTip?: boolean | undefined;
  nowMs?: number | undefined;
  recordUpdatedAt?: Date | string | null | undefined;
  staleThresholdSeconds?: number | undefined;
  maxLedgerLag?: number | undefined;
}

export const DEFAULT_FRESHNESS_STALE_SECONDS = 30;
export const DEFAULT_MAX_LEDGER_LAG = 6;
export const DEFAULT_FINALITY_CONFIRMATION_LEDGERS = 1;

function parsePositiveIntEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

export function getStaleThresholdSeconds(): number {
  return parsePositiveIntEnv(
    'CHAIN_FRESHNESS_STALE_SECONDS',
    DEFAULT_FRESHNESS_STALE_SECONDS,
  );
}

export function getMaxLedgerLag(): number {
  return parsePositiveIntEnv('CHAIN_MAX_LEDGER_LAG', DEFAULT_MAX_LEDGER_LAG);
}

export function getFinalityConfirmationLedgers(): number {
  return parsePositiveIntEnv(
    'CHAIN_FINALITY_CONFIRMATION_LEDGERS',
    DEFAULT_FINALITY_CONFIRMATION_LEDGERS,
  );
}

function toValidDate(value: Date | string | null | undefined): Date | null {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function toNonNegativeLedger(value: number | null | undefined): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    return null;
  }
  return Math.floor(value);
}

/**
 * Pure, deterministic classification of chain freshness and finality metadata.
 */
export function computeChainFreshness(
  input: ComputeFreshnessInput,
): ChainFreshnessMetadata {
  const nowMs = input.nowMs ?? Date.now();
  const evaluatedAt = new Date(nowMs).toISOString();
  const network = input.network ?? getConfiguredStellarNetwork();
  const source: DataSource = input.source ?? 'indexer';
  const staleThresholdSeconds =
    input.staleThresholdSeconds ?? getStaleThresholdSeconds();
  const maxLedgerLag = input.maxLedgerLag ?? getMaxLedgerLag();

  const indexedLedger = toNonNegativeLedger(input.indexedLedger);
  const verifiedCheckpointLedger = toNonNegativeLedger(
    input.verifiedCheckpointLedger,
  );
  const networkLedger = toNonNegativeLedger(input.networkLedger);
  const effectiveIndexedDate =
    toValidDate(input.indexedAt) ?? toValidDate(input.recordUpdatedAt);
  const indexedAt = effectiveIndexedDate
    ? effectiveIndexedDate.toISOString()
    : null;
  const ageSeconds = effectiveIndexedDate
    ? Math.max(0, Math.floor((nowMs - effectiveIndexedDate.getTime()) / 1000))
    : null;

  const ledgerLag =
    networkLedger !== null && indexedLedger !== null
      ? Math.max(0, networkLedger - indexedLedger)
      : null;

  // Direct on-chain read via Soroban RPC.
  if (source === 'chain') {
    const finalized = networkLedger !== null || verifiedCheckpointLedger !== null;
    return {
      network,
      source,
      freshness: input.probeError ? 'degraded' : 'fresh',
      stale: Boolean(input.probeError),
      finality: finalized ? 'finalized' : 'unknown',
      indexedLedger,
      verifiedCheckpointLedger,
      networkLedger,
      ledgerLag,
      indexedAt,
      ageSeconds,
      staleThresholdSeconds,
      maxLedgerLag,
      evaluatedAt,
      degradedReason: input.probeError ?? null,
      recoveryHint: input.probeError
        ? 'Direct chain read succeeded, but auxiliary freshness probes failed. Retry or verify on Stellar RPC.'
        : null,
    };
  }

  // Explicit probe failure (database/RPC unavailable when reading freshness state).
  if (input.probeError) {
    return {
      network,
      source,
      freshness: 'degraded',
      stale: true,
      finality: 'unknown',
      indexedLedger,
      verifiedCheckpointLedger,
      networkLedger,
      ledgerLag,
      indexedAt,
      ageSeconds,
      staleThresholdSeconds,
      maxLedgerLag,
      evaluatedAt,
      degradedReason: input.probeError,
      recoveryHint:
        'Chain freshness metadata could not be verified. Retry shortly or query Soroban RPC directly before acting on balances.',
    };
  }

  // Cold start / no indexed snapshot available.
  if (indexedLedger === null && indexedAt === null) {
    return {
      network,
      source,
      freshness: 'unknown',
      stale: true,
      finality: 'unknown',
      indexedLedger: null,
      verifiedCheckpointLedger,
      networkLedger,
      ledgerLag: null,
      indexedAt: null,
      ageSeconds: null,
      staleThresholdSeconds,
      maxLedgerLag,
      evaluatedAt,
      degradedReason: 'INDEXER_STATE_UNAVAILABLE',
      recoveryHint:
        'Indexer has not recorded a ledger checkpoint yet. Verify state directly on-chain or retry after ingestion catches up.',
    };
  }

  const isAgeStale = ageSeconds !== null && ageSeconds > staleThresholdSeconds;
  const isLagStale = ledgerLag !== null && ledgerLag > maxLedgerLag;

  if (isAgeStale || isLagStale) {
    const degradedReason = isLagStale
      ? `INDEXER_LEDGER_LAG_EXCEEDED (${ledgerLag} > ${maxLedgerLag} ledgers)`
      : `INDEXER_AGE_EXCEEDED (${ageSeconds}s > ${staleThresholdSeconds}s)`;

    return {
      network,
      source,
      freshness: 'stale',
      stale: true,
      finality: 'stale',
      indexedLedger,
      verifiedCheckpointLedger,
      networkLedger,
      ledgerLag,
      indexedAt,
      ageSeconds,
      staleThresholdSeconds,
      maxLedgerLag,
      evaluatedAt,
      degradedReason,
      recoveryHint:
        'Indexed state lags behind the chain tip. Wait for indexer catch-up or verify directly against Soroban RPC before submitting transactions.',
    };
  }

  // Fresh indexed data: distinguish checkpoint-verified finality from unverified indexed state.
  const hasVerifiedCheckpoint =
    verifiedCheckpointLedger !== null &&
    (indexedLedger === null || verifiedCheckpointLedger >= indexedLedger);

  if (hasVerifiedCheckpoint) {
    return {
      network,
      source,
      freshness: 'fresh',
      stale: false,
      finality: 'finalized',
      indexedLedger,
      verifiedCheckpointLedger,
      networkLedger,
      ledgerLag,
      indexedAt,
      ageSeconds,
      staleThresholdSeconds,
      maxLedgerLag,
      evaluatedAt,
      degradedReason: null,
      recoveryHint: null,
    };
  }

  return {
    network,
    source,
    freshness: 'fresh',
    stale: false,
    finality: 'indexed_unverified',
    indexedLedger,
    verifiedCheckpointLedger,
    networkLedger,
    ledgerLag,
    indexedAt,
    ageSeconds,
    staleThresholdSeconds,
    maxLedgerLag,
    evaluatedAt,
    degradedReason: null,
    recoveryHint:
      'Indexed state is current, but no verified ledger checkpoint covers this ledger yet. Confirm finality via Stellar RPC for settlement-critical workflows.',
  };
}

/**
 * Evaluate finality for a specific ledger sequence (for example an individual
 * stream event or transaction receipt).
 */
export function evaluateLedgerFinality(
  input: EvaluateLedgerFinalityInput,
): TransactionFinalityMetadata {
  const nowMs = input.nowMs ?? Date.now();
  const evaluatedAt = new Date(nowMs).toISOString();
  const network = input.network ?? getConfiguredStellarNetwork();
  const requiredConfirmations =
    input.confirmationLedgers ?? getFinalityConfirmationLedgers();
  const ledgerSequence = toNonNegativeLedger(input.ledgerSequence);
  const verifiedCheckpointLedger = toNonNegativeLedger(
    input.verifiedCheckpointLedger,
  );
  const networkLedger = toNonNegativeLedger(input.networkLedger);

  if (input.reverted) {
    return {
      network,
      ledgerSequence,
      finality: 'stale',
      confirmations: 0,
      verifiedByCheckpoint: false,
      reverted: true,
      evaluatedAt,
      recoveryHint:
        'This ledger was reverted during fork reconciliation. Re-fetch canonical stream state and events.',
    };
  }

  if (ledgerSequence === null) {
    return {
      network,
      ledgerSequence: null,
      finality: 'pending',
      confirmations: null,
      verifiedByCheckpoint: false,
      reverted: false,
      evaluatedAt,
      recoveryHint:
        'Transaction is not yet recorded in a closed ledger. Poll RPC or wait for ledger close before treating funds as settled.',
    };
  }

  const tipLedger =
    networkLedger !== null && verifiedCheckpointLedger !== null
      ? Math.max(networkLedger, verifiedCheckpointLedger)
      : (networkLedger ?? verifiedCheckpointLedger);

  const confirmations =
    tipLedger !== null && tipLedger >= ledgerSequence
      ? tipLedger - ledgerSequence + 1
      : 0;

  const verifiedByCheckpoint =
    verifiedCheckpointLedger !== null &&
    verifiedCheckpointLedger >= ledgerSequence;

  if (verifiedByCheckpoint && confirmations >= requiredConfirmations) {
    return {
      network,
      ledgerSequence,
      finality: 'finalized',
      confirmations,
      verifiedByCheckpoint: true,
      reverted: false,
      evaluatedAt,
      recoveryHint: null,
    };
  }

  if (networkLedger !== null && networkLedger >= ledgerSequence) {
    return {
      network,
      ledgerSequence,
      finality: 'indexed_unverified',
      confirmations,
      verifiedByCheckpoint,
      reverted: false,
      evaluatedAt,
      recoveryHint:
        'Ledger is closed on-chain but awaiting checkpoint corroboration or additional confirmations.',
    };
  }

  return {
    network,
    ledgerSequence,
    finality: 'pending',
    confirmations,
    verifiedByCheckpoint,
    reverted: false,
    evaluatedAt,
    recoveryHint:
      'Ledger has not been confirmed by the indexer checkpoint or network tip yet. Retry shortly.',
  };
}

interface IndexerStateLike {
  lastLedger?: number | null;
  updatedAt?: Date | string | null;
}

interface LedgerCheckpointLike {
  ledgerSequence?: number | null;
  processedAt?: Date | string | null;
}

interface OptionalFreshnessPrismaClient {
  indexerState?: {
    findUnique?: (args: {
      where: { id: string };
    }) => Promise<IndexerStateLike | null>;
  };
  ledgerCheckpoint?: {
    findFirst?: (args: {
      where: { isReverted: boolean };
      orderBy: { ledgerSequence: 'desc' };
    }) => Promise<LedgerCheckpointLike | null>;
  };
}

/**
 * Query persisted indexer state, verified checkpoints, and (optionally) the
 * live network tip to construct authoritative freshness and finality metadata.
 *
 * Never throws: probe failures are surfaced explicitly as `freshness: "degraded"`
 * with a machine-readable `degradedReason` and operator/client `recoveryHint`.
 */
export async function getChainFreshnessMetadata(
  options: GetChainFreshnessOptions = {},
): Promise<ChainFreshnessMetadata> {
  const nowMs = options.nowMs ?? Date.now();
  const network = getConfiguredStellarNetwork();
  const prismaLike = prisma as unknown as OptionalFreshnessPrismaClient;

  let indexedLedger: number | null = null;
  let indexedAt: Date | string | null = null;
  let verifiedCheckpointLedger: number | null = null;
  let networkLedger: number | null = null;
  const probeErrors: string[] = [];

  if (typeof prismaLike.indexerState?.findUnique === 'function') {
    try {
      const state = await prismaLike.indexerState.findUnique({
        where: { id: INDEXER_STATE_ID },
      });
      if (state) {
        indexedLedger = toNonNegativeLedger(state.lastLedger ?? null);
        indexedAt = state.updatedAt ?? null;
      }
    } catch (err) {
      logger.warn('[FreshnessService] Failed to query indexerState:', err);
      probeErrors.push('INDEXER_STATE_QUERY_FAILED');
    }
  }

  if (typeof prismaLike.ledgerCheckpoint?.findFirst === 'function') {
    try {
      const checkpoint = await prismaLike.ledgerCheckpoint.findFirst({
        where: { isReverted: false },
        orderBy: { ledgerSequence: 'desc' },
      });
      if (checkpoint) {
        verifiedCheckpointLedger = toNonNegativeLedger(
          checkpoint.ledgerSequence ?? null,
        );
        if (!indexedAt && checkpoint.processedAt) {
          indexedAt = checkpoint.processedAt;
        }
        if (indexedLedger === null && verifiedCheckpointLedger !== null) {
          indexedLedger = verifiedCheckpointLedger;
        }
      }
    } catch (err) {
      logger.warn('[FreshnessService] Failed to query ledgerCheckpoint:', err);
      probeErrors.push('CHECKPOINT_QUERY_FAILED');
    }
  }

  if (options.includeNetworkTip) {
    try {
      const tip = await getLatestLedger();
      networkLedger = toNonNegativeLedger(tip);
      if (networkLedger === null) {
        probeErrors.push('NETWORK_TIP_UNAVAILABLE');
      }
    } catch (err) {
      logger.warn('[FreshnessService] Failed to query network tip:', err);
      probeErrors.push('NETWORK_TIP_QUERY_FAILED');
    }
  }

  return computeChainFreshness({
    network,
    source: options.source ?? 'indexer',
    indexedLedger,
    verifiedCheckpointLedger,
    networkLedger,
    indexedAt,
    recordUpdatedAt: options.recordUpdatedAt,
    staleThresholdSeconds: options.staleThresholdSeconds,
    maxLedgerLag: options.maxLedgerLag,
    nowMs,
    probeError: probeErrors.length > 0 ? probeErrors.join(',') : null,
  });
}

/**
 * Attach standardized chain freshness and finality response headers.
 * Safely no-ops if a unit test passes a partial Response mock without `setHeader`.
 */
export function attachFreshnessHeaders(
  res: Response,
  metadata: ChainFreshnessMetadata,
): void {
  if (typeof res.setHeader !== 'function') {
    return;
  }

  res.setHeader('X-Chain-Network', metadata.network);
  res.setHeader('X-Chain-Data-Source', metadata.source);
  res.setHeader('X-Chain-Freshness', metadata.freshness);
  res.setHeader('X-Chain-Finality', metadata.finality);

  if (metadata.indexedLedger !== null) {
    res.setHeader('X-Chain-Indexed-Ledger', String(metadata.indexedLedger));
  }
  if (metadata.verifiedCheckpointLedger !== null) {
    res.setHeader(
      'X-Chain-Verified-Checkpoint-Ledger',
      String(metadata.verifiedCheckpointLedger),
    );
  }
  if (metadata.networkLedger !== null) {
    res.setHeader('X-Chain-Network-Ledger', String(metadata.networkLedger));
  }
  if (metadata.ledgerLag !== null) {
    res.setHeader('X-Chain-Ledger-Lag', String(metadata.ledgerLag));
  }
}
