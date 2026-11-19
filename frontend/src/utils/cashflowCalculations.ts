export type StreamDirection = "incoming" | "outgoing";

export interface ProjectionStream {
  id: string;
  direction: StreamDirection;
  token: string;
  deposited: number;
  withdrawn: number;
  ratePerSecond: number;
  isActive: boolean;
  isPaused?: boolean;
  startTime?: number;
  cliffDates?: number[];
}

export interface CashflowPoint { date: Date; actual: number; projected: number; balance: number; dailyRate: number; }

export function projectCashflow(streams: ProjectionStream[], horizonDays: number, now = new Date()): CashflowPoint[] {
  const start = new Date(now); start.setHours(0, 0, 0, 0);
  let balance = streams.filter((stream) => stream.direction === "outgoing").reduce((sum, stream) => sum + Math.max(0, stream.deposited - stream.withdrawn), 0);
  let cumulative = streams.filter((stream) => stream.direction === "incoming").reduce((sum, stream) => sum + stream.withdrawn, 0);
  return Array.from({ length: horizonDays + 1 }, (_, index) => {
    const date = new Date(start); date.setDate(start.getDate() + index);
    // The series starts at the beginning of today, so the first point has not
    // had a full day to accrue yet. Crediting it one day of flow would shift the
    // whole projection a day into the future.
    const day = index === 0 ? 0 : streams.reduce((total, stream) => {
      if (!stream.isActive || stream.isPaused || (stream.startTime && stream.startTime * 1000 > date.getTime())) return total;
      const amount = stream.ratePerSecond * 86400;
      return total + (stream.direction === "incoming" ? amount : -amount);
    }, 0);
    cumulative += Math.max(0, day);
    balance = Math.max(0, balance + Math.min(0, day));
    return { date, actual: index === 0 ? cumulative : 0, projected: cumulative, balance, dailyRate: day };
  });
}

export function estimateRunwayDate(streams: ProjectionStream[], now = new Date()): Date | null {
  const outgoing = streams.filter((stream) => stream.direction === "outgoing" && stream.isActive && !stream.isPaused);
  const balance = outgoing.reduce((sum, stream) => sum + Math.max(0, stream.deposited - stream.withdrawn), 0);
  const rate = outgoing.reduce((sum, stream) => sum + stream.ratePerSecond * 86400, 0);
  if (balance <= 0 || rate <= 0) return null;
  return new Date(now.getTime() + (balance / rate) * 86400000);
}

export function getCliffDates(streams: ProjectionStream[]): Date[] {
  return streams.flatMap((stream) => (stream.cliffDates ?? []).map((timestamp) => new Date(timestamp * 1000))).sort((a, b) => a.getTime() - b.getTime());
}

/** Default age (ms) after which indexer-sourced stream data is considered stale. */
export const DEFAULT_STALE_THRESHOLD_MS = 5 * 60 * 1000;

export interface PortfolioTokenExposure {
  token: string;
  /** Remaining (deposited - withdrawn) on active, non-paused outgoing streams. */
  outgoingLiability: number;
  /** Remaining (deposited - withdrawn) on active, non-paused incoming streams. */
  incomingExpected: number;
  /** Remaining on paused streams, reported but excluded from accruing obligations. */
  pausedOutgoing: number;
  pausedIncoming: number;
  /** Share of total remaining exposure (incoming + outgoing) held in this token, 0..1. */
  concentration: number;
}

export interface PortfolioExposure {
  tokens: PortfolioTokenExposure[];
  totalOutgoingLiability: number;
  totalIncomingExpected: number;
  totalPausedOutgoing: number;
  totalPausedIncoming: number;
  /** Latest stream update timestamp (ms) across all streams, or null when none. */
  sourceTimestamp: number | null;
  /** True when the newest source timestamp is older than the threshold. */
  stale: boolean;
}

function remaining(stream: ProjectionStream): number {
  return Math.max(0, stream.deposited - stream.withdrawn);
}

/**
 * Aggregate outgoing liabilities, incoming expected payments and per-token
 * concentration across a portfolio of streams. Paused streams are reported
 * separately and never contribute to accruing obligations. Pure function so it
 * can be exercised without a DOM.
 */
export function computePortfolioExposure(
  streams: ProjectionStream[],
  options: { now?: number; staleThresholdMs?: number } = {},
): PortfolioExposure {
  const now = options.now ?? Date.now();
  const staleThresholdMs = options.staleThresholdMs ?? DEFAULT_STALE_THRESHOLD_MS;
  const byToken = new Map<string, PortfolioTokenExposure>();

  const entry = (token: string): PortfolioTokenExposure => {
    let existing = byToken.get(token);
    if (!existing) {
      existing = { token, outgoingLiability: 0, incomingExpected: 0, pausedOutgoing: 0, pausedIncoming: 0, concentration: 0 };
      byToken.set(token, existing);
    }
    return existing;
  };

  let sourceTimestamp: number | null = null;
  for (const stream of streams) {
    if (typeof stream.startTime === "number") {
      const ts = stream.startTime * 1000;
      sourceTimestamp = sourceTimestamp === null ? ts : Math.max(sourceTimestamp, ts);
    }
    const amount = remaining(stream);
    const target = entry(stream.token);
    const paused = stream.isPaused === true || !stream.isActive;
    if (stream.direction === "outgoing") {
      if (paused) target.pausedOutgoing += amount;
      else target.outgoingLiability += amount;
    } else if (paused) {
      target.pausedIncoming += amount;
    } else {
      target.incomingExpected += amount;
    }
  }

  const tokens = Array.from(byToken.values());
  const totalOutgoingLiability = tokens.reduce((sum, t) => sum + t.outgoingLiability, 0);
  const totalIncomingExpected = tokens.reduce((sum, t) => sum + t.incomingExpected, 0);
  const totalPausedOutgoing = tokens.reduce((sum, t) => sum + t.pausedOutgoing, 0);
  const totalPausedIncoming = tokens.reduce((sum, t) => sum + t.pausedIncoming, 0);
  const totalExposure = totalOutgoingLiability + totalIncomingExpected;
  for (const token of tokens) {
    const tokenExposure = token.outgoingLiability + token.incomingExpected;
    token.concentration = totalExposure > 0 ? tokenExposure / totalExposure : 0;
  }

  const stale = sourceTimestamp === null || now - sourceTimestamp > staleThresholdMs;

  return {
    tokens,
    totalOutgoingLiability,
    totalIncomingExpected,
    totalPausedOutgoing,
    totalPausedIncoming,
    sourceTimestamp,
    stale,
  };
}