import { randomUUID } from 'crypto';
import { prisma } from '../lib/prisma.js';
import { INDEXER_STATE_ID } from '../lib/indexer-state.js';
import { sorobanEventWorker } from '../workers/soroban-event-worker.js';
import logger, { requestContext } from '../logger.js';
import {
  buildContractConfigKey,
  validateContractIndexerConfig,
  type ContractIndexerConfigInput,
  type ContractIndexerValidationError,
} from '../lib/indexer-contract-config.js';

export interface IndexerStatus {
  lastLedger: number;
  lastCursor: string | null;
  updatedAt: Date;
  lagSeconds: number;
}

export async function getIndexerStatus(): Promise<IndexerStatus> {
  const state = await prisma.indexerState.findUnique({ where: { id: INDEXER_STATE_ID } });
  const lagSeconds = state ? Math.floor((Date.now() - state.updatedAt.getTime()) / 1000) : -1;
  return {
    lastLedger: state?.lastLedger ?? 0,
    lastCursor: state?.lastCursor ?? null,
    updatedAt: state?.updatedAt ?? new Date(0),
    lagSeconds,
  };
}

export async function resetIndexer(toLedger: number): Promise<void> {
  // Acquire the same mutex that serialises poll/replay batches so that an
  // in-flight poll cannot overwrite the reset cursor after we write it (#1221).
  await sorobanEventWorker.runExclusive(async () => {
    await prisma.indexerState.upsert({
      where: { id: INDEXER_STATE_ID },
      create: { id: INDEXER_STATE_ID, lastLedger: toLedger, lastCursor: null },
      update: { lastLedger: toLedger, lastCursor: null },
    });
  });
  logger.info(`[IndexerService] Reset lastProcessedLedger to ${toLedger}`);
}

/**
 * Preview what a reset would do without mutating state.
 * Returns the current cursor and the target ledger so operators can
 * verify the intended scope before committing.
 */
export interface ResetPreview {
  currentLastLedger: number;
  currentLastCursor: string | null;
  targetLastLedger: number;
}

export async function previewReset(targetLedger: number): Promise<ResetPreview> {
  const state = await prisma.indexerState.findUnique({
    where: { id: INDEXER_STATE_ID },
  });
  return {
    currentLastLedger: state?.lastLedger ?? 0,
    currentLastCursor: state?.lastCursor ?? null,
    targetLastLedger: targetLedger,
  };
}

/**
 * Preview what a replay from a given ledger would do without mutating state.
 * Returns the event count, ledger range, and current cursor so operators can
 * sanity-check before committing a destructive replay.
 *
 * This function performs no writes: it only reads indexer state and stream
 * events, so it is safe to call repeatedly before an execution.
 */
export interface ReplayPreview {
  fromLedger: number;
  currentLastLedger: number;
  currentLastCursor: string | null;
  eventCount: number;
  minLedgerInReplayRange: number | null;
  maxLedgerInReplayRange: number | null;
}

export async function previewReplay(
  fromLedger: number,
): Promise<ReplayPreview> {
  const state = await prisma.indexerState.findUnique({
    where: { id: INDEXER_STATE_ID },
  });
  const currentLastLedger = state?.lastLedger ?? 0;

  const rangeFilter: import('../generated/prisma/index.js').Prisma.StreamEventWhereInput =
    currentLastLedger > 0
      ? { ledgerSequence: { gte: fromLedger, lte: currentLastLedger } }
      : { ledgerSequence: { gte: fromLedger } };

  const [eventCount, aggregate] = await Promise.all([
    prisma.streamEvent.count({ where: rangeFilter }),
    prisma.streamEvent.aggregate({
      where: rangeFilter,
      _min: { ledgerSequence: true },
      _max: { ledgerSequence: true },
    }),
  ]);

  return {
    fromLedger,
    currentLastLedger,
    currentLastCursor: state?.lastCursor ?? null,
    eventCount,
    minLedgerInReplayRange: aggregate._min.ledgerSequence,
    maxLedgerInReplayRange: aggregate._max.ledgerSequence,
  };
}

/**
 * Structured, auditable report describing the outcome of a replay execution.
 *
 * - `requestId` correlates the report with logs and the triggering request.
 * - `durationMs` is the wall-clock time spent executing the replay.
 * - `eventCount` / `minLedgerInReplayRange` / `maxLedgerInReplayRange` mirror
 *   the preview so operators can compare expected vs. actual scope.
 * - `failurePosition` is the ledger at which execution failed (if any).
 * - `cursorPreserved` indicates whether the live cursor was left untouched
 *   because the replay failed.
 */
export interface ReplayExecutionReport {
  requestId: string;
  fromLedger: number;
  success: boolean;
  durationMs: number;
  eventCount: number;
  minLedgerInReplayRange: number | null;
  maxLedgerInReplayRange: number | null;
  previousLastLedger: number;
  previousLastCursor: string | null;
  failurePosition: number | null;
  errorMessage: string | null;
  cursorPreserved: boolean;
}

/**
 * Execute a replay from `fromLedger` and return a structured report.
 *
 * On failure the live cursor is restored to its pre-execution value so that
 * a subsequent retry starts from the same position and produces a
 * reproducible summary.
 */
export async function executeReplay(
  fromLedger: number,
  customRequestId?: string,
): Promise<ReplayExecutionReport> {
  const requestId = customRequestId || requestContext.getStore()?.requestId || randomUUID();
  return requestContext.run({ requestId }, async () => {
    const startedAt = Date.now();
    const preview = await previewReplay(fromLedger);
    const previousLastLedger = preview.currentLastLedger;
    const previousLastCursor = preview.currentLastCursor;

    try {
      await resetIndexer(fromLedger);
      await sorobanEventWorker.triggerPoll(requestId);
      const durationMs = Date.now() - startedAt;
      logger.info(
        `[IndexerService] Replay executed from ledger ${fromLedger} (requestId=${requestId}, durationMs=${durationMs}, eventCount=${preview.eventCount})`,
      );
      return {
        requestId,
        fromLedger,
        success: true,
        durationMs,
        eventCount: preview.eventCount,
        minLedgerInReplayRange: preview.minLedgerInReplayRange,
        maxLedgerInReplayRange: preview.maxLedgerInReplayRange,
        previousLastLedger,
        previousLastCursor,
        failurePosition: null,
        errorMessage: null,
        cursorPreserved: false,
      };
    } catch (err) {
      const durationMs = Date.now() - startedAt;
      const errorMessage = err instanceof Error ? err.message : String(err);
      // Restore the live cursor so a retry starts from the same position.
      await sorobanEventWorker.runExclusive(async () => {
        await prisma.indexerState.upsert({
          where: { id: INDEXER_STATE_ID },
          create: {
            id: INDEXER_STATE_ID,
            lastLedger: previousLastLedger,
            lastCursor: previousLastCursor,
          },
          update: {
            lastLedger: previousLastLedger,
            lastCursor: previousLastCursor,
          },
        });
      });
      logger.error(
        `[IndexerService] Replay failed from ledger ${fromLedger} (requestId=${requestId}, durationMs=${durationMs}, failurePosition=${fromLedger}): ${errorMessage}`,
      );
      return {
        requestId,
        fromLedger,
        success: false,
        durationMs,
        eventCount: preview.eventCount,
        minLedgerInReplayRange: preview.minLedgerInReplayRange,
        maxLedgerInReplayRange: preview.maxLedgerInReplayRange,
        previousLastLedger,
        previousLastCursor,
        failurePosition: fromLedger,
        errorMessage,
        cursorPreserved: true,
      };
    }
  });
}

export async function replayFromLedger(fromLedger: number, customRequestId?: string): Promise<string> {
  const report = await executeReplay(fromLedger, customRequestId);
  return report.requestId;
}

/**
 * A single per-contract indexing configuration as persisted.
 *
 * Each config is keyed by `configKey`, which is derived from the network
 * identity plus the contract address. This isolates cursors and event
 * schemas so that:
 *   - two deployments on the same network (different addresses) get
 *     distinct configs, and
 *   - the same contract address on separate networks (different network
 *     identities) also gets distinct configs.
 */
export interface ContractIndexerConfig {
  configKey: string;
  network: string;
  networkPassphrase: string;
  contractAddress: string;
  label: string | null;
  enabled: boolean;
  startLedger: number;
  lastLedger: number;
  lastCursor: string | null;
  updatedAt: Date;
}

/**
 * Operator-facing status for a single per-contract config.
 *
 * `validationErrors` surfaces configuration problems (e.g. malformed
 * address, mismatched network identity) so operators can see why a config
 * is not being indexed. `lagSeconds` is -1 when the config has never been
 * polled.
 */
export interface ContractIndexerStatus {
  configKey: string;
  network: string;
  networkPassphrase: string;
  contractAddress: string;
  label: string | null;
  enabled: boolean;
  lastLedger: number;
  lastCursor: string | null;
  updatedAt: Date;
  lagSeconds: number;
  validationErrors: ContractIndexerValidationError[];
}

export interface ContractIndexerStatusReport {
  generatedAt: Date;
  configs: ContractIndexerStatus[];
}

function toContractIndexerConfig(row: {
  configKey: string;
  network: string;
  networkPassphrase: string;
  contractAddress: string;
  label: string | null;
  enabled: boolean;
  startLedger: number;
  lastLedger: number;
  lastCursor: string | null;
  updatedAt: Date;
}): ContractIndexerConfig {
  return {
    configKey: row.configKey,
    network: row.network,
    networkPassphrase: row.networkPassphrase,
    contractAddress: row.contractAddress,
    label: row.label,
    enabled: row.enabled,
    startLedger: row.startLedger,
    lastLedger: row.lastLedger,
    lastCursor: row.lastCursor,
    updatedAt: row.updatedAt,
  };
}

/**
 * List all persisted per-contract indexing configs, ordered by network then
 * contract address for stable operator output.
 */
export async function listContractIndexerConfigs(): Promise<ContractIndexerConfig[]> {
  const rows = await prisma.contractIndexerConfig.findMany({
    orderBy: [{ network: 'asc' }, { contractAddress: 'asc' }],
  });
  return rows.map(toContractIndexerConfig);
}

/**
 * Create or update a per-contract indexing config.
 *
 * Validation is delegated to the `indexer-contract-config` module. Invalid
 * input is rejected (thrown) before any write so that a bad config can never
 * clobber a working cursor. The `configKey` is derived from the network
 * identity and contract address, so re-submitting the same deployment is an
 * idempotent update while a different deployment or network yields a new row.
 */
export async function upsertContractIndexerConfig(
  input: ContractIndexerConfigInput,
): Promise<ContractIndexerConfig> {
  const validation = validateContractIndexerConfig(input);
  if (!validation.valid) {
    const summary = validation.errors.map((e) => `${e.field}: ${e.message}`).join('; ');
    throw new Error(`Invalid contract indexer config: ${summary}`);
  }

  const configKey = buildContractConfigKey(input);
  const startLedger = input.startLedger ?? 0;

  const row = await prisma.contractIndexerConfig.upsert({
    where: { configKey },
    create: {
      configKey,
      network: input.network,
      networkPassphrase: input.networkPassphrase,
      contractAddress: input.contractAddress,
      label: input.label ?? null,
      enabled: input.enabled ?? true,
      startLedger,
      lastLedger: startLedger,
      lastCursor: null,
    },
    update: {
      label: input.label ?? null,
      enabled: input.enabled ?? true,
      // Only advance the start ledger forward; never rewind an existing cursor.
      startLedger,
    },
  });

  logger.info(
    `[IndexerService] Upserted contract indexer config ${configKey} (network=${input.network}, contract=${input.contractAddress})`,
  );
  return toContractIndexerConfig(row);
}

/**
 * Disable a per-contract indexing config without deleting its cursor.
 *
 * Returns the updated config, or `null` if no config exists for `configKey`.
 * Disabling preserves `lastLedger`/`lastCursor` so re-enabling resumes from
 * the same position.
 */
export async function disableContractIndexerConfig(
  configKey: string,
): Promise<ContractIndexerConfig | null> {
  const existing = await prisma.contractIndexerConfig.findUnique({ where: { configKey } });
  if (!existing) {
    return null;
  }
  const row = await prisma.contractIndexerConfig.update({
    where: { configKey },
    data: { enabled: false },
  });
  logger.info(`[IndexerService] Disabled contract indexer config ${configKey}`);
  return toContractIndexerConfig(row);
}

/**
 * Build the operator-facing status report for all per-contract configs.
 *
 * Each entry carries its own network identity and cursor so that two
 * deployments on one network and the same address on separate networks are
 * clearly distinguishable. Validation errors are recomputed on read so that
 * configs persisted before a validation rule tightened are still surfaced.
 */
export async function getContractIndexerStatus(): Promise<ContractIndexerStatusReport> {
  const configs = await listContractIndexerConfigs();
  const now = Date.now();

  const statuses: ContractIndexerStatus[] = configs.map((config) => {
    const validation = validateContractIndexerConfig({
      network: config.network,
      networkPassphrase: config.networkPassphrase,
      contractAddress: config.contractAddress,
      label: config.label ?? undefined,
      enabled: config.enabled,
      startLedger: config.startLedger,
    });
    const lagSeconds =
      config.lastLedger > 0 ? Math.floor((now - config.updatedAt.getTime()) / 1000) : -1;
    return {
      configKey: config.configKey,
      network: config.network,
      networkPassphrase: config.networkPassphrase,
      contractAddress: config.contractAddress,
      label: config.label,
      enabled: config.enabled,
      lastLedger: config.lastLedger,
      lastCursor: config.lastCursor,
      updatedAt: config.updatedAt,
      lagSeconds,
      validationErrors: validation.errors,
    };
  });

  return { generatedAt: new Date(now), configs: statuses };
}
