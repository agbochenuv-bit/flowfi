import type { Stream } from "../types/stream";

export interface StreamCalculation {
  /** Total amount that has vested so far (or will vest by `asOf`). */
  vested: number;
  /** Total amount that has been withdrawn so far. */
  withdrawn: number;
  /** Amount currently available to withdraw. */
  available: number;
  /** Amount still scheduled to vest in the future. */
  remaining: number;
  /** Whether the stream is currently paused. */
  paused: boolean;
  /** Whether the stream has fully ended (end date reached or fully vested). */
  ended: boolean;
}

/**
 * Compute the vested / withdrawn / available / remaining breakdown for a
 * single stream at a given point in time. This is the canonical calculation
 * used by stream detail views; the cash-flow calendar reconciles against it.
 */
export function calculateStream(
  stream: Stream,
  asOf: Date = new Date(),
): StreamCalculation {
  const now = asOf.getTime();
  const start = new Date(stream.startTime).getTime();
  const end = stream.endTime ? new Date(stream.endTime).getTime() : null;
  const total = Number(stream.totalAmount);
  const withdrawn = Number(stream.withdrawnAmount ?? 0);

  const paused = Boolean(stream.paused);
  const ended = end !== null && now >= end;

  let vested: number;
  if (now <= start) {
    vested = 0;
  } else if (end === null || now >= end) {
    vested = total;
  } else {
    const elapsed = now - start;
    const duration = end - start;
    vested = duration <= 0 ? total : (total * elapsed) / duration;
  }

  // Paused streams do not accrue new vesting beyond what was already vested
  // at pause time; callers pass the pause timestamp via `stream.pausedAt`.
  if (paused && stream.pausedAt) {
    const pausedAt = new Date(stream.pausedAt).getTime();
    if (pausedAt < now) {
      const pausedCalc = calculateStream(
        { ...stream, paused: false },
        new Date(pausedAt),
      );
      vested = Math.min(vested, pausedCalc.vested);
    }
  }

  const available = Math.max(0, vested - withdrawn);
  const remaining = Math.max(0, total - vested);

  return { vested, withdrawn, available, remaining, paused, ended };
}

export interface CashFlowDay {
  /** ISO calendar day (YYYY-MM-DD) in the requested timezone. */
  date: string;
  /** Expected incoming amount for this day (estimate). */
  incoming: number;
  /** Expected outgoing amount for this day (estimate). */
  outgoing: number;
  /** Net expected flow for this day (estimate). */
  net: number;
  /** Whether any contributing stream is paused or uncertain. */
  uncertain: boolean;
}

export interface CashFlowCalendar {
  days: CashFlowDay[];
  totalIncoming: number;
  totalOutgoing: number;
  totalNet: number;
  /** True when at least one contributing stream is paused or has no end date. */
  hasUncertainty: boolean;
}

/**
 * Format a timestamp as a YYYY-MM-DD calendar day in the given IANA timezone.
 * Falls back to UTC when the timezone is invalid so bucketing never throws.
 */
export function toCalendarDay(timestamp: number | string | Date, timeZone: string): string {
  const date = timestamp instanceof Date ? timestamp : new Date(timestamp);
  try {
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).formatToParts(date);
    const year = parts.find((p) => p.type === "year")?.value ?? "0000";
    const month = parts.find((p) => p.type === "month")?.value ?? "01";
    const day = parts.find((p) => p.type === "day")?.value ?? "01";
    return `${year}-${month}-${day}`;
  } catch {
    return date.toISOString().slice(0, 10);
  }
}

function eachDay(from: string, to: string): string[] {
  const days: string[] = [];
  const start = new Date(`${from}T00:00:00Z`).getTime();
  const end = new Date(`${to}T00:00:00Z`).getTime();
  if (Number.isNaN(start) || Number.isNaN(end) || end < start) return days;
  for (let t = start; t <= end; t += 24 * 60 * 60 * 1000) {
    days.push(new Date(t).toISOString().slice(0, 10));
  }
  return days;
}

/**
 * Build a cash-flow calendar of expected stream activity over a period.
 *
 * Amounts are estimates of scheduled vesting, not guaranteed settlement.
 * Paused streams contribute nothing while paused; streams with an end date
 * stop contributing after that date. Streams without an end date are marked
 * uncertain because their remaining schedule is open-ended.
 */
export function buildCashFlowCalendar(
  streams: Stream[],
  periodStart: Date,
  periodEnd: Date,
  timeZone: string = "UTC",
): CashFlowCalendar {
  const from = toCalendarDay(periodStart, timeZone);
  const to = toCalendarDay(periodEnd, timeZone);
  const dayKeys = eachDay(from, to);
  const buckets = new Map<string, CashFlowDay>();
  for (const key of dayKeys) {
    buckets.set(key, { date: key, incoming: 0, outgoing: 0, net: 0, uncertain: false });
  }

  let hasUncertainty = false;

  for (const stream of streams) {
    const start = new Date(stream.startTime).getTime();
    const end = stream.endTime ? new Date(stream.endTime).getTime() : null;
    const total = Number(stream.totalAmount);
    const withdrawn = Number(stream.withdrawnAmount ?? 0);
    const isIncoming = stream.direction !== "outgoing";
    const uncertain = Boolean(stream.paused) || end === null;
    if (uncertain) hasUncertainty = true;

    // Paused streams do not schedule new activity.
    if (stream.paused) continue;

    const effectiveEnd = end ?? periodEnd.getTime();
    const spanStart = Math.max(start, periodStart.getTime());
    const spanEnd = Math.min(effectiveEnd, periodEnd.getTime());
    if (spanEnd <= spanStart) continue;

    const duration = (end ?? start) - start;
    const perMs = duration > 0 ? total / duration : 0;

    for (const day of dayKeys) {
      const dayStart = new Date(`${day}T00:00:00Z`).getTime();
      const dayEnd = dayStart + 24 * 60 * 60 * 1000;
      const overlapStart = Math.max(spanStart, dayStart);
      const overlapEnd = Math.min(spanEnd, dayEnd);
      if (overlapEnd <= overlapStart) continue;

      const amount = perMs * (overlapEnd - overlapStart);
      const bucket = buckets.get(day);
      if (!bucket) continue;
      if (isIncoming) {
        bucket.incoming += amount;
      } else {
        bucket.outgoing += amount;
      }
      bucket.net = bucket.incoming - bucket.outgoing;
      if (uncertain) bucket.uncertain = true;
    }
  }

  const days = dayKeys.map((key) => buckets.get(key)!);
  const totalIncoming = days.reduce((sum, d) => sum + d.incoming, 0);
  const totalOutgoing = days.reduce((sum, d) => sum + d.outgoing, 0);

  return {
    days,
    totalIncoming,
    totalOutgoing,
    totalNet: totalIncoming - totalOutgoing,
    hasUncertainty,
  };
}
