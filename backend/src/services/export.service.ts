/**
 * Transaction Export Service for Tax & Accounting (Issue #1191)
 * Generates CSV/JSON exports for bookkeeping and tax filings
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
 */
function buildWhereClause(
  userAddress: string,
  options: ExportOptions,
): any {
  const { direction, startDate, endDate, tokenAddress } = options;

  const where: any = { OR: [] };

  if (direction === "outgoing" || direction === "all") {
    where.OR.push({ sender: userAddress });
  }
  if (direction === "incoming" || direction === "all") {
    where.OR.push({ recipient: userAddress });
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
].join(",");

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
    timestamp: new Date(Number(event.timestamp) * 1000).toISOString(),
    streamId: stream.streamId.toString(),
    transactionHash: event.transactionHash,
    eventType: event.eventType,
    direction,
    counterpartyAddress: counterparty,
    tokenContract: stream.tokenAddress,
    grossAmountStroops: grossAmount,
    grossAmountFormatted: formatAmount(grossAmount),
    protocolFeeDeducted: protocolFee,
    netAmount: formatAmount(netAmount),
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
  ].join(",");
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

  // Write CSV header
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

  // Start JSON array
  res.write('{"transactions":[');

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
      `],"metadata":{"totalRecords":${processedCount},"exportedAt":"${new Date().toISOString()}","userAddress":"${userAddress}"}}`,
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
