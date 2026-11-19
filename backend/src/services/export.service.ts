/**
 * Transaction Export Service for Tax & Accounting (Issue #1191)
 * Generates CSV/JSON exports for bookkeeping and tax filings
 *
 * Rate limiting (Issue #72):
 * - Exports are expensive operations and are gated by the principal-aware
 *   limiter at the route layer (see routes/export.routes.ts). Budgets are
 *   keyed by authenticated principal when available, otherwise by trusted
 *   client IP (forwarding headers are only honored behind a trusted proxy).
 * - When the limiter rejects a request it responds with the shared 429
 *   envelope before this service is invoked, so no partial export is written.
 * - If Redis is unavailable the limiter falls back to a conservative
 *   in-process budget; multi-instance counters are not shared in that mode.
 * - The export output format is unchanged by rate limiting.
 */
import type { Response } from "express";
import { prisma } from "../lib/prisma.js";
import logger from "../logger.js";

export interface ExportOptions {
  format: "csv" | "json";
  direction: "incoming" | "outgoing" | "all";
  startDate?: Date | null;
  endDate?: Date | null;
  tokenAddress?: string | null;
}

/**
 * Versioned column schema for accounting-friendly exports (Issue #239).
 *
 * Every export artifact is self-describing: the schema version is embedded in
 * the CSV header comment / JSON metadata so downstream bookkeeping tools can
 * parse it reproducibly. Columns are stable and additive-only within a major
 * version.
 *
 * Timezone rule: all timestamps are emitted as ISO-8601 strings in UTC
 * (`YYYY-MM-DDTHH:mm:ss.sssZ`). Date range filters are interpreted as UTC
 * instants. No local timezone conversion is ever applied.
 *
 * Units rule: amounts are emitted as integer stroops (7 decimals for Stellar
 * assets) in `*Stroops` columns and as fixed-point decimal strings in the
 * formatted columns. `amountDecimals` is always present so consumers never
 * have to guess the scale.
 */
export const EXPORT_SCHEMA_VERSION = "1.0.0";

export interface ExportColumnSchema {
  name: string;
  description: string;
  unit?: string;
}

export const EXPORT_COLUMN_SCHEMA: readonly ExportColumnSchema[] = [
  { name: "timestamp", description: "Event time, ISO-8601 UTC", unit: "ISO-8601 UTC" },
  { name: "streamId", description: "On-chain stream identifier", unit: "uint256" },
  { name: "txHash", description: "Transaction reference", unit: "hex" },
  { name: "eventType", description: "Stream lifecycle event type", unit: "enum" },
  { name: "direction", description: "INCOMING or OUTGOING relative to owner", unit: "enum" },
  { name: "counterpartyAddress", description: "Other party in the transfer", unit: "address" },
  { name: "asset", description: "Token contract address", unit: "address" },
  { name: "networkId", description: "Chain/network identifier", unit: "string" },
  { name: "amountStroops", description: "Gross amount in integer stroops", unit: "stroops" },
  { name: "amountDecimals", description: "Decimals applied to formatted amounts", unit: "integer" },
  { name: "amountFormatted", description: "Gross amount as decimal string", unit: "decimal" },
  { name: "protocolFeeStroops", description: "Protocol fee in integer stroops", unit: "stroops" },
  { name: "netAmountStroops", description: "Net amount in integer stroops", unit: "stroops" },
  { name: "netAmountFormatted", description: "Net amount as decimal string", unit: "decimal" },
] as const;

/** Default decimals for Stellar assets. */
export const EXPORT_AMOUNT_DECIMALS = 7;

/** Default job lifetime for asynchronous exports (24 hours). */
const DEFAULT_JOB_TTL_MS = 24 * 60 * 60 * 1000;

/** Default upper bound on rows produced by a single export (large-result limit). */
const DEFAULT_MAX_EXPORT_ROWS = 100_000;

/**
 * Resolve the job TTL from the environment, clamped to a sane range.
 */
function resolveJobTtlMs(): number {
  const raw = Number(process.env.EXPORT_JOB_TTL_MS);
  if (!Number.isFinite(raw) || raw <= 0) return DEFAULT_JOB_TTL_MS;
  return Math.min(Math.floor(raw), 7 * 24 * 60 * 60 * 1000);
}

/**
 * Resolve the large-result row limit from the environment.
 */
function resolveMaxExportRows(): number {
  const raw = Number(process.env.EXPORT_MAX_ROWS);
  if (!Number.isFinite(raw) || raw <= 0) return DEFAULT_MAX_EXPORT_ROWS;
  return Math.min(Math.floor(raw), 10_000_000);
}

/**
 * Resolve the network identifier recorded in exports. Defaults to the
 * configured Stellar network so artifacts are unambiguous.
 */
function resolveNetworkId(): string {
  return (
    process.env.EXPORT_NETWORK_ID ||
    process.env.STELLAR_NETWORK ||
    process.env.STELLAR_NETWORK_PASSPHRASE ||
    "unknown"
  );
}

export type ExportJobStatus =
  | "queued"
  | "running"
  | "completed"
  | "failed"
  | "cancelled"
  | "expired";

export interface ExportJobRecord {
  id: string;
  ownerPublicKey: string;
  status: ExportJobStatus;
  format: "csv" | "json";
  options: ExportOptions;
  snapshotMaxCreatedAt: bigint;
  snapshotMaxId: string;
  cursorCreatedAt: bigint | null;
  cursorId: string | null;
  rowCount: number;
  artifact: string | null;
  error: string | null;
  expiresAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

export interface ExportJobView {
  id: string;
  status: ExportJobStatus;
  format: "csv" | "json";
  rowCount: number;
  schemaVersion: string;
  expiresAt: string;
  createdAt: string;
  updatedAt: string;
  error?: string;
}

/**
 * Minimal persistence contract for export jobs. The Prisma-backed
 * implementation lives in `prismaExportJobStore`; tests can supply an
 * in-memory store without touching the database.
 */
export interface ExportJobStore {
  create(data: {
    ownerPublicKey: string;
    status: ExportJobStatus;
    format: "csv" | "json";
    options: ExportOptions;
    snapshotMaxCreatedAt: bigint;
    snapshotMaxId: string;
    expiresAt: Date;
  }): Promise<ExportJobRecord>;
  findById(id: string): Promise<ExportJobRecord | null>;
  update(id: string, data: Partial<ExportJobRecord>): Promise<ExportJobRecord>;
}

let jobStore: ExportJobStore | null = null;

/**
 * Register the persistence backend used for export jobs. Called once at
 * startup (or by tests with an in-memory implementation).
 */
export function setExportJobStore(store: ExportJobStore | null): void {
  jobStore = store;
}

function requireJobStore(): ExportJobStore {
  if (!jobStore) {
    throw new Error("Export job store is not configured");
  }
  return jobStore;
}

/**
 * Prisma-backed export job store. Uses the `exportJob` model; the model is
 * intentionally accessed through `any` so this module keeps compiling in
 * deployments that have not yet run the migration.
 */
export const prismaExportJobStore: ExportJobStore = {
  async create(data) {
    const created = await (prisma as any).exportJob.create({ data });
    return created as ExportJobRecord;
  },
  async findById(id) {
    const found = await (prisma as any).exportJob.findUnique({ where: { id } });
    return (found as ExportJobRecord | null) ?? null;
  },
  async update(id, data) {
    const updated = await (prisma as any).exportJob.update({
      where: { id },
      data,
    });
    return updated as ExportJobRecord;
  },
};

/**
 * Snapshot upper bound captured at export start. Every batch query is
 * constrained to events at or before this point so that events arriving
 * mid-export are excluded and results are deterministic.
 */
interface ExportSnapshot {
  maxCreatedAt: bigint;
  maxId: string;
}

const DEFAULT_BATCH_SIZE = 100;
const MAX_BATCH_SIZE = 1000;

/**
 * Resolve the batch size from the environment, clamped to a safe range so
 * memory use stays bounded regardless of configuration.
 */
function resolveBatchSize(): number {
  const raw = Number(process.env.EXPORT_BATCH_SIZE);
  if (!Number.isFinite(raw) || raw <= 0) return DEFAULT_BATCH_SIZE;
  return Math.min(Math.floor(raw), MAX_BATCH_SIZE);
}

/**
 * Validate export options, throwing a descriptive error on invalid input.
 */
function validateExportOptions(options: ExportOptions): void {
  const { direction, startDate, endDate, tokenAddress } = options;

  if (!["incoming", "outgoing", "all"].includes(direction)) {
    throw new Error(`Invalid direction: ${String(direction)}`);
  }

  if (startDate && Number.isNaN(startDate.getTime())) {
    throw new Error("Invalid startDate");
  }
  if (endDate && Number.isNaN(endDate.getTime())) {
    throw new Error("Invalid endDate");
  }
  if (startDate && endDate && startDate.getTime() > endDate.getTime()) {
    throw new Error("startDate must be before or equal to endDate");
  }

  if (tokenAddress !== undefined && tokenAddress !== null) {
    if (typeof tokenAddress !== "string" || tokenAddress.trim() === "") {
      throw new Error("Invalid tokenAddress");
    }
  }
}

/**
 * Capture the snapshot upper bound for the export. Uses the maximum
 * (createdAt, id) currently present so pagination is stable.
 */
async function captureSnapshot(): Promise<ExportSnapshot> {
  const latest = await prisma.streamEvent.findFirst({
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    select: { createdAt: true, id: true },
  });

  if (!latest) {
    return { maxCreatedAt: 0n, maxId: "" };
  }

  return { maxCreatedAt: latest.createdAt, maxId: latest.id };
}

/**
 * Build the base where clause shared by both export formats.
 *
 * Ownership is enforced structurally: the OR list can only ever contain the
 * caller's own address as sender or recipient, so rows belonging to other
 * wallets can never be selected regardless of the requested direction.
 */
function buildWhereClause(
  userAddress: string,
  options: ExportOptions,
): any {
  const { direction, tokenAddress } = options;

  if (!userAddress || typeof userAddress !== "string") {
    throw new Error("Invalid userAddress");
  }

  const where: any = { OR: [] };

  if (direction === "outgoing" || direction === "all") {
    where.OR.push({ sender: userAddress });
  }
  if (direction === "incoming" || direction === "all") {
    where.OR.push({ recipient: userAddress });
  }

  if (where.OR.length === 0) {
    // No direction matched: return an impossible predicate rather than
    // accidentally widening the query.
    where.OR.push({ sender: userAddress, recipient: userAddress, id: "__none__" });
  }

  if (tokenAddress) {
    where.tokenAddress = tokenAddress;
  }

  return where;
}

/**
 * Build the event-level where clause, including the snapshot upper bound
 * and any date range filters.
 */
function buildEventWhere(
  options: ExportOptions,
  snapshot: ExportSnapshot,
): any {
  const { startDate, endDate } = options;

  const timestamp: any = {};
  if (startDate) timestamp.gte = BigInt(Math.floor(startDate.getTime() / 1000));
  if (endDate) timestamp.lte = BigInt(Math.floor(endDate.getTime() / 1000));

  const eventWhere: any = {
    OR: [
      { createdAt: { lt: snapshot.maxCreatedAt } },
      { createdAt: snapshot.maxCreatedAt, id: { lte: snapshot.maxId } },
    ],
  };

  if (Object.keys(timestamp).length > 0) {
    eventWhere.timestamp = timestamp;
  }

  return eventWhere;
}

export interface TransactionRecord {
  timestamp: string;
  streamId: string;
  transactionHash: string;
  eventType: string;
  direction: "OUTGOING" | "INCOMING";
  counterpartyAddress: string;
  tokenContract: string;
  grossAmountStroops: string;
  grossAmountFormatted: string;
  protocolFeeDeducted: string;
  netAmount: string;
  /** Chain/network identifier (Issue #239). */
  networkId?: string;
  /** Decimals applied to formatted amounts (Issue #239). */
  amountDecimals?: number;
}

const CSV_HEADERS = [
  "Timestamp (UTC)",
  "Stream ID",
  "Transaction Hash",
  "Event Type",
  "Direction",
  "Counterparty Address",
  "Token Contract",
  "Gross Amount (Stroops)",
  "Gross Amount (Formatted)",
  "Protocol Fee Deducted",
  "Net Amount",
  "Network ID",
  "Amount Decimals",
].join(",");

/**
 * CSV header comment carrying the schema version and timezone rule so the
 * artifact is self-describing when parsed by accounting tools.
 */
function buildCSVHeaderComment(): string {
  return (
    `# schemaVersion=${EXPORT_SCHEMA_VERSION} ` +
    `timezone=UTC amountDecimals=${EXPORT_AMOUNT_DECIMALS} ` +
    `networkId=${resolveNetworkId()}\n`
  );
}

/**
 * Format a timestamp as ISO-8601 UTC. Always UTC: no local conversion.
 */
function formatTimestampUTC(seconds: bigint | number): string {
  const ms = Number(seconds) * 1000;
  return new Date(ms).toISOString();
}

/**
 * Format amount from stroops (i128) to human-readable decimal
 * Assumes 7 decimals for Stellar tokens
 */
function formatAmount(stroops: string, decimals = 7): string {
  const amount = BigInt(stroops);
  const divisor = BigInt(10 ** decimals);
  const wholePart = amount / divisor;
  const fractionalPart = amount % divisor;

  return `${wholePart}.${fractionalPart.toString().padStart(decimals, "0")}`;
}

/**
 * Calculate protocol fee (simplified - adjust based on actual fee structure)
 */
function calculateProtocolFee(amount: string, eventType: string): string {
  // Example: 0.5% fee on withdrawals
  if (eventType === "WITHDRAWN") {
    const amt = BigInt(amount);
    const fee = (amt * 5n) / 1000n; // 0.5%
    return fee.toString();
  }
  return "0";
}

/**
 * Convert database records to transaction export format
 */
function mapEventToTransaction(
  event: any,
  stream: any,
  userAddress: string,
): TransactionRecord {
  const isOutgoing = stream.sender === userAddress;
  const direction = isOutgoing ? "OUTGOING" : "INCOMING";
  const counterparty = isOutgoing ? stream.recipient : stream.sender;

  const grossAmount = event.amount || "0";
  const protocolFee = calculateProtocolFee(grossAmount, event.eventType);
  const netAmount = (BigInt(grossAmount) - BigInt(protocolFee)).toString();

  return {
    timestamp: formatTimestampUTC(event.timestamp),
    streamId: stream.streamId.toString(),
    transactionHash: event.transactionHash,
    eventType: event.eventType,
    direction,
    counterpartyAddress: counterparty,
    tokenContract: stream.tokenAddress,
    grossAmountStroops: grossAmount,
    grossAmountFormatted: formatAmount(grossAmount, EXPORT_AMOUNT_DECIMALS),
    protocolFeeDeducted: protocolFee,
    netAmount: formatAmount(netAmount, EXPORT_AMOUNT_DECIMALS),
    networkId: resolveNetworkId(),
    amountDecimals: EXPORT_AMOUNT_DECIMALS,
  };
}

/**
 * Convert transaction record to CSV row
 */
function transactionToCSVRow(record: TransactionRecord): string {
  const escapeCSV = (value: string): string => {
    if (value.includes(",") || value.includes('"') || value.includes("\n")) {
      return `"${value.replace(/"/g, '""')}"`;
    }
    return value;
  };

  return [
    escapeCSV(record.timestamp),
    escapeCSV(record.streamId),
    escapeCSV(record.transactionHash),
    escapeCSV(record.eventType),
    escapeCSV(record.direction),
    escapeCSV(record.counterpartyAddress),
    escapeCSV(record.tokenContract),
    escapeCSV(record.grossAmountStroops),
    escapeCSV(record.grossAmountFormatted),
    escapeCSV(record.protocolFeeDeducted),
    escapeCSV(record.netAmount),
    escapeCSV(record.networkId ?? resolveNetworkId()),
    escapeCSV(String(record.amountDecimals ?? EXPORT_AMOUNT_DECIMALS)),
  ].join(",");
}

/**
 * Parse a single CSV data row back into a TransactionRecord. Used by tests
 * and by consumers to verify round-trip fidelity.
 */
export function parseCSVRow(row: string): TransactionRecord {
  const cells: string[] = [];
  let current = "";
  let inQuotes = false;

  for (let i = 0; i < row.length; i++) {
    const ch = row[i];
    if (inQuotes) {
      if (ch === '"' && row[i + 1] === '"') {
        current += '"';
        i++;
      } else if (ch === '"') {
        inQuotes = false;
      } else {
        current += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ",") {
      cells.push(current);
      current = "";
    } else {
      current += ch;
    }
  }
  cells.push(current);

  return {
    timestamp: cells[0] ?? "",
    streamId: cells[1] ?? "",
    transactionHash: cells[2] ?? "",
    eventType: cells[3] ?? "",
    direction: (cells[4] as "OUTGOING" | "INCOMING") ?? "INCOMING",
    counterpartyAddress: cells[5] ?? "",
    tokenContract: cells[6] ?? "",
    grossAmountStroops: cells[7] ?? "",
    grossAmountFormatted: cells[8] ?? "",
    protocolFeeDeducted: cells[9] ?? "",
    netAmount: cells[10] ?? "",
    networkId: cells[11] ?? undefined,
    amountDecimals: cells[12] ? Number(cells[12]) : undefined,
  };
}

/**
 * Stream transaction export as CSV
 */
export async function streamTransactionCSV(
  userAddress: string,
  options: ExportOptions,
  res: Response,
): Promise<void> {
  try {
    validateExportOptions(options);
  } catch (error) {
    logger.warn("[Export] Invalid CSV export options:", error);
    res.status(400).json({ error: (error as Error).message });
    return;
  }

  const where = buildWhereClause(userAddress, options);

  // Set response headers
  const filename = `flowfi-statement-${userAddress}-${new Date().toISOString().split("T")[0]}.csv`;
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
  res.setHeader("Transfer-Encoding", "chunked");

  // Write schema comment + CSV header
  res.write(buildCSVHeaderComment());
  res.write(CSV_HEADERS + "\n");

  try {
    const snapshot = await captureSnapshot();
    const eventWhere = buildEventWhere(options, snapshot);
    const BATCH_SIZE = resolveBatchSize();

    let cursor: { createdAt: bigint; id: string } | undefined;
    let processedCount = 0;

    while (true) {
      const streams = await prisma.stream.findMany({
        where,
        take: BATCH_SIZE,
        ...(cursor
          ? {
              skip: 1,
              cursor: { createdAt_id: cursor },
            }
          : {}),
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
        include: {
          events: {
            where: eventWhere,
            orderBy: [{ timestamp: "asc" }, { id: "asc" }],
          },
        },
      });

      if (streams.length === 0) break;

      for (const stream of streams) {
        for (const event of stream.events) {
          const transaction = mapEventToTransaction(event, stream, userAddress);
          const row = transactionToCSVRow(transaction);
          res.write(row + "\n");
          processedCount++;
        }
      }

      const lastStream = streams[streams.length - 1];
      if (lastStream) {
        cursor = { createdAt: lastStream.createdAt, id: lastStream.id };
      }

      if (streams.length < BATCH_SIZE) break;
    }

    res.end();
    logger.info(
      `[Export] CSV export complete: ${processedCount} transactions for ${userAddress}`,
    );
  } catch (error) {
    logger.error("[Export] CSV streaming error:", error);
    if (!res.headersSent) {
      res.status(500).json({ error: "Export failed" });
    }
  }
}

/**
 * Stream transaction export as JSON
 */
export async function streamTransactionJSON(
  userAddress: string,
  options: ExportOptions,
  res: Response,
): Promise<void> {
  try {
    validateExportOptions(options);
  } catch (error) {
    logger.warn("[Export] Invalid JSON export options:", error);
    res.status(400).json({ error: (error as Error).message });
    return;
  }

  const where = buildWhereClause(userAddress, options);

  // Set response headers
  const filename = `flowfi-statement-${userAddress}-${new Date().toISOString().split("T")[0]}.json`;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
  res.setHeader("Transfer-Encoding", "chunked");

  // Start JSON envelope with schema metadata
  res.write(
    `{"schemaVersion":"${EXPORT_SCHEMA_VERSION}","timezone":"UTC","amountDecimals":${EXPORT_AMOUNT_DECIMALS},"networkId":"${resolveNetworkId()}","transactions":[`,
  );

  try {
    const snapshot = await captureSnapshot();
    const eventWhere = buildEventWhere(options, snapshot);
    const BATCH_SIZE = resolveBatchSize();

    let cursor: { createdAt: bigint; id: string } | undefined;
    let processedCount = 0;
    let isFirst = true;

    while (true) {
      const streams = await prisma.stream.findMany({
        where,
        take: BATCH_SIZE,
        ...(cursor
          ? {
              skip: 1,
              cursor: { createdAt_id: cursor },
            }
          : {}),
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
        include: {
          events: {
            where: eventWhere,
            orderBy: [{ timestamp: "asc" }, { id: "asc" }],
          },
        },
      });

      if (streams.length === 0) break;

      for (const stream of streams) {
        for (const event of stream.events) {
          const transaction = mapEventToTransaction(event, stream, userAddress);

          if (!isFirst) {
            res.write(",");
          }
          res.write(JSON.stringify(transaction));
          isFirst = false;
          processedCount++;
        }
      }

      const lastStream = streams[streams.length - 1];
      if (lastStream) {
        cursor = { createdAt: lastStream.createdAt, id: lastStream.id };
      }

      if (streams.length < BATCH_SIZE) break;
    }

    // Close JSON array and add metadata
    res.write(
      `],"metadata":{"totalRecords":${processedCount},"exportedAt":"${new Date().toISOString()}","userAddress":"${userAddress}","schemaVersion":"${EXPORT_SCHEMA_VERSION}"}}`,
    );
    res.end();

    logger.info(
      `[Export] JSON export complete: ${processedCount} transactions for ${userAddress}`,
    );
  } catch (error) {
    logger.error("[Export] JSON streaming error:", error);
    if (!res.headersSent) {
      res.status(500).json({ error: "Export failed" });
    }
  }
}

/**
 * Create a resumable asynchronous export job (Issue #238).
 *
 * The snapshot upper bound is captured at creation time so that events
 * arriving after the job is queued are excluded from every batch, keeping
 * the artifact consistent across retries and resumptions.
 */
export async function createExportJob(
  ownerPublicKey: string,
  options: ExportOptions,
): Promise<ExportJobView> {
  if (!ownerPublicKey || typeof ownerPublicKey !== "string") {
    throw new Error("Invalid ownerPublicKey");
  }
  validateExportOptions(options);

  const store = requireJobStore();
  const snapshot = await captureSnapshot();
  const now = new Date();
  const expiresAt = new Date(now.getTime() + resolveJobTtlMs());

  const job = await store.create({
    ownerPublicKey,
    status: "queued",
    format: options.format,
    options,
    snapshotMaxCreatedAt: snapshot.maxCreatedAt,
    snapshotMaxId: snapshot.maxId,
    expiresAt,
  });

  logger.info(`[Export] Created export job ${job.id} for ${ownerPublicKey}`);
  return toJobView(job);
}

function toJobView(job: ExportJobRecord): ExportJobView {
  const view: ExportJobView = {
    id: job.id,
    status: job.status,
    format: job.format,
    rowCount: job.rowCount,
    schemaVersion: EXPORT_SCHEMA_VERSION,
    expiresAt: new Date(job.expiresAt).toISOString(),
    createdAt: new Date(job.createdAt).toISOString(),
    updatedAt: new Date(job.updatedAt).toISOString(),
  };
  if (job.error) view.error = job.error;
  return view;
}

/**
 * Fetch a job, enforcing ownership. Returns null when the job does not exist
 * or is owned by a different principal (callers must not distinguish the two
 * to avoid leaking job existence).
 */
export async function getExportJob(
  ownerPublicKey: string,
  jobId: string,
): Promise<ExportJobView | null> {
  const store = requireJobStore();
  const job = await store.findById(jobId);
  if (!job || job.ownerPublicKey !== ownerPublicKey) return null;
  return toJobView(job);
}

/**
 * Cancel a job that is still queued or running. Completed, failed, cancelled
 * and expired jobs are left untouched.
 */
export async function cancelExportJob(
  ownerPublicKey: string,
  jobId: string,
): Promise<ExportJobView | null> {
  const store = requireJobStore();
  const job = await store.findById(jobId);
  if (!job || job.ownerPublicKey !== ownerPublicKey) return null;

  if (job.status !== "queued" && job.status !== "running") {
    return toJobView(job);
  }

  const updated = await store.update(jobId, { status: "cancelled" });
  logger.info(`[Export] Cancelled export job ${jobId}`);
  return toJobView(updated);
}

/**
 * Authorize a download of a completed job's artifact.
 *
 * Checks ownership, completion status and expiry. Expired jobs are marked
 * expired and rejected. Returns the artifact on success.
 */
export async function authorizeDownload(
  ownerPublicKey: string,
  jobId: string,
): Promise<{ artifact: string; format: "csv" | "json" }> {
  const store = requireJobStore();
  const job = await store.findById(jobId);

  if (!job || job.ownerPublicKey !== ownerPublicKey) {
    throw new Error("Export job not found");
  }

  if (job.status === "completed" && new Date(job.expiresAt).getTime() <= Date.now()) {
    await store.update(jobId, { status: "expired" });
    throw new Error("Export job expired");
  }

  if (job.status === "expired" || new Date(job.expiresAt).getTime() <= Date.now()) {
    if (job.status !== "expired") {
      await store.update(jobId, { status: "expired" });
    }
    throw new Error("Export job expired");
  }

  if (job.status !== "completed") {
    throw new Error(`Export job is not ready (status=${job.status})`);
  }

  if (job.artifact === null) {
    throw new Error("Export artifact unavailable");
  }

  return { artifact: job.artifact, format: job.format };
}

/**
 * Process one bounded batch of an export job.
 *
 * Idempotent for retries: the persisted cursor only advances after a batch is
 * fully appended to the artifact, and rows are regenerated deterministically
 * from the snapshot + cursor. Events after the snapshot are always excluded.
 *
 * Returns the updated job view. Call repeatedly until status is terminal.
 */
export async function processExportJob(jobId: string): Promise<ExportJobView> {
  const store = requireJobStore();
  const job = await store.findById(jobId);
  if (!job) throw new Error("Export job not found");

  if (
    job.status === "completed" ||
    job.status === "failed" ||
    job.status === "cancelled" ||
    job.status === "expired"
  ) {
    return toJobView(job);
  }

  if (new Date(job.expiresAt).getTime() <= Date.now()) {
    const expired = await store.update(jobId, { status: "expired" });
    return toJobView(expired);
  }

  if (job.status === "queued") {
    await store.update(jobId, { status: "running" });
  }

  try {
    const snapshot: ExportSnapshot = {
      maxCreatedAt: job.snapshotMaxCreatedAt,
      maxId: job.snapshotMaxId,
    };
    const where = buildWhereClause(job.ownerPublicKey, job.options);
    const eventWhere = buildEventWhere(job.options, snapshot);
    const BATCH_SIZE = resolveBatchSize();
    const maxRows = resolveMaxExportRows();

    const cursor =
      job.cursorCreatedAt !== null && job.cursorId !== null
        ? { createdAt: job.cursorCreatedAt, id: job.cursorId }
        : undefined;

    const streams = await prisma.stream.findMany({
      where,
      take: BATCH_SIZE,
      ...(cursor ? { skip: 1, cursor: { createdAt_id: cursor } } : {}),
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      include: {
        events: {
          where: eventWhere,
          orderBy: [{ timestamp: "asc" }, { id: "asc" }],
        },
      },
    });

    const records: TransactionRecord[] = [];
    for (const stream of streams) {
      for (const event of stream.events) {
        records.push(mapEventToTransaction(event, stream, job.ownerPublicKey));
      }
    }

    let rowCount = job.rowCount;
    let artifact = job.artifact ?? "";

    if (job.format === "csv") {
      if (artifact === "") artifact = buildCSVHeaderComment() + CSV_HEADERS + "\n";
      for (const record of records) {
        if (rowCount >= maxRows) break;
        artifact += transactionToCSVRow(record) + "\n";
        rowCount++;
      }
    } else {
      if (artifact === "") {
        artifact =
          `{"schemaVersion":"${EXPORT_SCHEMA_VERSION}","timezone":"UTC",` +
          `"amountDecimals":${EXPORT_AMOUNT_DECIMALS},"networkId":"${resolveNetworkId()}",` +
          `"transactions":[`;
      }
      for (const record of records) {
        if (rowCount >= maxRows) break;
        artifact += (rowCount === 0 ? "" : ",") + JSON.stringify(record);
        rowCount++;
      }
    }

    const lastStream = streams[streams.length - 1];
    const nextCursor = lastStream
      ? { createdAt: lastStream.createdAt, id: lastStream.id }
      : cursor;

    const hitLimit = rowCount >= maxRows;
    const isDone = streams.length < BATCH_SIZE || hitLimit;

    if (isDone) {
      if (job.format === "json") {
        artifact +=
          `],"metadata":{"totalRecords":${rowCount},` +
          `"exportedAt":"${new Date().toISOString()}",` +
          `"userAddress":"${job.ownerPublicKey}",` +
          `"schemaVersion":"${EXPORT_SCHEMA_VERSION}"}}`;
      }
      const updated = await store.update(jobId, {
        status: "completed",
        artifact,
        rowCount,
        cursorCreatedAt: nextCursor?.createdAt ?? null,
        cursorId: nextCursor?.id ?? null,
      });
      logger.info(`[Export] Completed export job ${jobId} (${rowCount} rows)`);
      return toJobView(updated);
    }

    const updated = await store.update(jobId, {
      status: "running",
      artifact,
      rowCount,
      cursorCreatedAt: nextCursor?.createdAt ?? null,
      cursorId: nextCursor?.id ?? null,
    });
    return toJobView(updated);
  } catch (error) {
    logger.error(`[Export] Export job ${jobId} failed:`, error);
    const failed = await store.update(jobId, {
      status: "failed",
      error: (error as Error).message,
    });
    return toJobView(failed);
  }
}
