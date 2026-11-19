// frontend/src/lib/stream-preview.ts

/**
 * Pure preview module for stream change actions.
 *
 * Given an authoritative current stream snapshot and a proposed action,
 * `buildStreamChangePreview` returns before/after fields, explicit assumption
 * labels, and a `stale` flag when the snapshot is older than the caller-provided
 * freshness threshold.
 *
 * Design notes:
 * - Inputs are never mutated.
 * - Amounts are handled at 7-decimal precision (Stellar stroop-like precision).
 * - Canceled/closed streams are treated as non-actionable.
 * - All derived values are computed from authoritative inputs; assumptions are
 *   surfaced via `assumptions` so the UI can label them.
 */

/** Number of decimal places used for stream amounts. */
export const STREAM_AMOUNT_DECIMALS = 7;

/** Scale factor for 7-decimal precision (10^7). */
export const STREAM_AMOUNT_SCALE = 10 ** STREAM_AMOUNT_DECIMALS;

/** Statuses that make a stream non-actionable. */
export const NON_ACTIONABLE_STATUSES = ['canceled', 'cancelled', 'closed'] as const;

export type StreamStatus =
  | 'active'
  | 'scheduled'
  | 'paused'
  | 'canceled'
  | 'cancelled'
  | 'closed'
  | (string & {});

export type StreamActionType =
  | 'top-up'
  | 'schedule-update'
  | 'beneficiary-change'
  | 'cancellation';

/** Authoritative current stream snapshot. */
export interface CurrentStreamSnapshot {
  /** Remaining (unstreamed) amount, as a decimal string or number. */
  remainingAmount: string | number;
  /** Streaming rate per second, as a decimal string or number. */
  ratePerSecond: string | number;
  /** End time as an ISO-8601 string or epoch milliseconds. */
  endTime: string | number;
  /** Current beneficiary address. */
  beneficiary: string;
  /** Current stream status. */
  status: StreamStatus;
  /** When the snapshot was last updated (ISO-8601 or epoch ms). */
  updatedAt: string | number;
  /** Optional ledger sequence at which the snapshot was taken. */
  ledger?: number;
}

export interface TopUpAction {
  type: 'top-up';
  /** Amount to add to the stream. */
  amount: string | number;
}

export interface ScheduleUpdateAction {
  type: 'schedule-update';
  /** New end time (ISO-8601 or epoch ms). */
  endTime: string | number;
  /** Optional new rate per second. If omitted, rate is derived from remaining amount and new duration. */
  ratePerSecond?: string | number;
}

export interface BeneficiaryChangeAction {
  type: 'beneficiary-change';
  /** New beneficiary address. */
  beneficiary: string;
}

export interface CancellationAction {
  type: 'cancellation';
}

export type StreamAction =
  | TopUpAction
  | ScheduleUpdateAction
  | BeneficiaryChangeAction
  | CancellationAction;

export interface FreshnessThreshold {
  /**
   * Maximum age (in milliseconds) of the snapshot before it is considered stale.
   * If omitted, staleness is only evaluated against `maxLedgerAge` (if provided).
   */
  maxAgeMs?: number;
  /**
   * Reference "now" used to evaluate age. Defaults to Date.now().
   * Provided for deterministic testing.
   */
  now?: number | string;
  /**
   * Optional current ledger sequence. If provided along with the snapshot's
   * ledger, the snapshot is stale when `currentLedger - snapshot.ledger` exceeds
   * `maxLedgerAge`.
   */
  currentLedger?: number;
  /** Maximum allowed ledger age before the snapshot is considered stale. */
  maxLedgerAge?: number;
}

export interface StreamChangePreview {
  /** The action being previewed. */
  actionType: StreamActionType;
  /** Whether the stream can be acted upon at all. */
  actionable: boolean;
  /** Reason the stream is non-actionable, if applicable. */
  nonActionableReason?: string;
  /** Whether the snapshot is older than the freshness threshold. */
  stale: boolean;
  /** Human-readable assumption labels describing derived values. */
  assumptions: string[];
  /** Fields before the action. */
  before: StreamPreviewFields;
  /** Fields after the action. */
  after: StreamPreviewFields;
  /** Deltas between before and after. */
  delta: StreamPreviewDelta;
}

export interface StreamPreviewFields {
  remainingAmount: string;
  ratePerSecond: string;
  endTime: string;
  beneficiary: string;
  status: StreamStatus;
}

export interface StreamPreviewDelta {
  /** Change in remaining amount (after - before), as a decimal string. */
  remainingAmount: string;
  /** Change in rate per second (after - before), as a decimal string. */
  ratePerSecond: string;
  /** Change in end time in milliseconds (after - before). */
  endTimeMs: number;
  /** Whether the beneficiary changed. */
  beneficiaryChanged: boolean;
  /** Whether the status changed. */
  statusChanged: boolean;
}

/* -------------------------------------------------------------------------- */
/* Amount helpers (7-decimal precision)                                        */
/* -------------------------------------------------------------------------- */

/**
 * Parse a decimal amount into a scaled integer (7-decimal precision).
 * Throws on invalid input.
 */
export function parseAmount(value: string | number): bigint {
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new Error(`Invalid amount: ${value}`);
    }
    // Convert via string to avoid floating point drift beyond 7 decimals.
    value = value.toString();
  }
  const trimmed = value.trim();
  if (trimmed === '') {
    throw new Error('Invalid amount: empty string');
  }
  const match = /^(-)?(\d+)(?:\.(\d+))?$/.exec(trimmed);
  if (!match) {
    throw new Error(`Invalid amount: ${value}`);
  }
  const sign = match[1] === '-' ? -1n : 1n;
  const whole = match[2];
  const fracRaw = match[3] ?? '';
  const frac = (fracRaw + '0'.repeat(STREAM_AMOUNT_DECIMALS)).slice(0, STREAM_AMOUNT_DECIMALS);
  const scaled = BigInt(whole) * BigInt(STREAM_AMOUNT_SCALE) + BigInt(frac || '0');
  return sign * scaled;
}

/**
 * Format a scaled integer (7-decimal precision) back into a decimal string.
 * Trailing zeros in the fractional part are trimmed; whole numbers have no
 * decimal point.
 */
export function formatAmount(scaled: bigint): string {
  const negative = scaled < 0n;
  const abs = negative ? -scaled : scaled;
  const whole = abs / BigInt(STREAM_AMOUNT_SCALE);
  const frac = abs % BigInt(STREAM_AMOUNT_SCALE);
  let fracStr = frac.toString().padStart(STREAM_AMOUNT_DECIMALS, '0');
  fracStr = fracStr.replace(/0+$/, '');
  const body = fracStr.length > 0 ? `${whole.toString()}.${fracStr}` : whole.toString();
  return negative ? `-${body}` : body;
}

/** Add two decimal amounts at 7-decimal precision. */
export function addAmounts(a: string | number, b: string | number): string {
  return formatAmount(parseAmount(a) + parseAmount(b));
}

/** Subtract `b` from `a` at 7-decimal precision. */
export function subtractAmounts(a: string | number, b: string | number): string {
  return formatAmount(parseAmount(a) - parseAmount(b));
}

/** Compare two decimal amounts at 7-decimal precision. */
export function compareAmounts(a: string | number, b: string | number): -1 | 0 | 1 {
  const av = parseAmount(a);
  const bv = parseAmount(b);
  if (av < bv) return -1;
  if (av > bv) return 1;
  return 0;
}

/* -------------------------------------------------------------------------- */
/* Time helpers                                                                */
/* -------------------------------------------------------------------------- */

/** Parse an ISO-8601 string or epoch milliseconds into epoch milliseconds. */
export function parseTime(value: string | number): number {
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new Error(`Invalid time: ${value}`);
    }
    return value;
  }
  const trimmed = value.trim();
  if (trimmed === '') {
    throw new Error('Invalid time: empty string');
  }
  // Numeric strings are treated as epoch milliseconds.
  if (/^-?\d+$/.test(trimmed)) {
    return Number(trimmed);
  }
  const parsed = Date.parse(trimmed);
  if (Number.isNaN(parsed)) {
    throw new Error(`Invalid time: ${value}`);
  }
  return parsed;
}

/** Format epoch milliseconds as an ISO-8601 string. */
export function formatTime(ms: number): string {
  return new Date(ms).toISOString();
}

/* -------------------------------------------------------------------------- */
/* Status helpers                                                              */
/* -------------------------------------------------------------------------- */

function isNonActionableStatus(status: StreamStatus): boolean {
  const normalized = String(status).toLowerCase();
  return (NON_ACTIONABLE_STATUSES as readonly string[]).includes(normalized);
}

/* -------------------------------------------------------------------------- */
/* Preview builder                                                             */
/* -------------------------------------------------------------------------- */

function snapshotToFields(snapshot: CurrentStreamSnapshot): StreamPreviewFields {
  return {
    remainingAmount: formatAmount(parseAmount(snapshot.remainingAmount)),
    ratePerSecond: formatAmount(parseAmount(snapshot.ratePerSecond)),
    endTime: formatTime(parseTime(snapshot.endTime)),
    beneficiary: snapshot.beneficiary,
    status: snapshot.status,
  };
}

function computeStale(
  snapshot: CurrentStreamSnapshot,
  threshold: FreshnessThreshold | undefined,
): boolean {
  if (!threshold) return false;

  let stale = false;

  if (typeof threshold.maxAgeMs === 'number') {
    const now = threshold.now !== undefined ? parseTime(threshold.now) : Date.now();
    const updatedAt = parseTime(snapshot.updatedAt);
    const age = now - updatedAt;
    if (age > threshold.maxAgeMs) {
      stale = true;
    }
  }

  if (
    typeof threshold.maxLedgerAge === 'number' &&
    typeof threshold.currentLedger === 'number' &&
    typeof snapshot.ledger === 'number'
  ) {
    if (threshold.currentLedger - snapshot.ledger > threshold.maxLedgerAge) {
      stale = true;
    }
  }

  return stale;
}

function buildDelta(
  before: StreamPreviewFields,
  after: StreamPreviewFields,
): StreamPreviewDelta {
  return {
    remainingAmount: subtractAmounts(after.remainingAmount, before.remainingAmount),
    ratePerSecond: subtractAmounts(after.ratePerSecond, before.ratePerSecond),
    endTimeMs: parseTime(after.endTime) - parseTime(before.endTime),
    beneficiaryChanged: before.beneficiary !== after.beneficiary,
    statusChanged: before.status !== after.status,
  };
}

/**
 * Build a side-by-side preview of how an action affects an existing stream.
 *
 * @param current Authoritative current stream snapshot.
 * @param action  Proposed action.
 * @param threshold Optional freshness threshold used to flag stale snapshots.
 */
export function buildStreamChangePreview(
  current: CurrentStreamSnapshot,
  action: StreamAction,
  threshold?: FreshnessThreshold,
): StreamChangePreview {
  const before = snapshotToFields(current);
  const stale = computeStale(current, threshold);
  const assumptions: string[] = [];

  const actionable = !isNonActionableStatus(current.status);
  const nonActionableReason = actionable
    ? undefined
    : `Stream status "${current.status}" is not actionable`;

  // Default: no change.
  let after: StreamPreviewFields = { ...before };

  if (!actionable) {
    // Non-actionable streams: preview reflects no change.
    assumptions.push('Stream is canceled/closed; no changes will be applied.');
    return {
      actionType: action.type,
      actionable,
      nonActionableReason,
      stale,
      assumptions,
      before,
      after,
      delta: buildDelta(before, after),
    };
  }

  switch (action.type) {
    case 'top-up': {
      const topUp = formatAmount(parseAmount(action.amount));
      if (compareAmounts(topUp, '0') <= 0) {
        throw new Error('Top-up amount must be greater than zero');
      }
      const newRemaining = addAmounts(before.remainingAmount, topUp);
      after = {
        ...before,
        remainingAmount: newRemaining,
      };
      assumptions.push(
        'Top-up increases the remaining amount; rate and end time are unchanged.',
      );
      break;
    }

    case 'schedule-update': {
      const newEndTimeMs = parseTime(action.endTime);
      const currentEndTimeMs = parseTime(before.endTime);
      if (newEndTimeMs <= currentEndTimeMs) {
        throw new Error('New end time must be after the current end time');
      }
      const newEndTime = formatTime(newEndTimeMs);

      let newRate: string;
      if (action.ratePerSecond !== undefined) {
        newRate = formatAmount(parseAmount(action.ratePerSecond));
        if (compareAmounts(newRate, '0') <= 0) {
          throw new Error('Rate per second must be greater than zero');
        }
        assumptions.push(
          'Rate per second is taken from the proposed schedule update.',
        );
      } else {
        // Derive rate from remaining amount over the new duration.
        const now = threshold?.now !== undefined ? parseTime(threshold.now) : Date.now();
        const durationMs = newEndTimeMs - now;
        if (durationMs <= 0) {
          throw new Error('New end time must be in the future to derive a rate');
        }
        const durationSeconds = durationMs / 1000;
        const remainingScaled = parseAmount(before.remainingAmount);
        // rate = remaining / durationSeconds, rounded down to 7 decimals.
        const rateScaled = (remainingScaled * BigInt(STREAM_AMOUNT_SCALE)) /
          BigInt(Math.round(durationSeconds * STREAM_AMOUNT_SCALE));
        newRate = formatAmount(rateScaled);
        assumptions.push(
          'Rate per second is derived from remaining amount and new duration (rounded down to 7 decimals).',
        );
        if (threshold?.now === undefined) {
          assumptions.push('Derivation uses current wall-clock time as the start.');
        }
      }

      after = {
        ...before,
        endTime: newEndTime,
        ratePerSecond: newRate,
      };
      break;
    }

    case 'beneficiary-change': {
      if (action.beneficiary === before.beneficiary) {
        throw new Error('New beneficiary must differ from the current beneficiary');
      }
      after = {
        ...before,
        beneficiary: action.beneficiary,
      };
      assumptions.push(
        'Beneficiary change does not affect amounts, rate, or end time.',
      );
      break;
    }

    case 'cancellation': {
      after = {
        ...before,
        status: 'canceled',
      };
      assumptions.push(
        'Cancellation stops the stream; remaining amount is shown as-is and may be refunded per protocol rules.',
      );
      break;
    }

    default: {
      // Exhaustiveness guard.
      const _exhaustive: never = action;
      throw new Error(`Unsupported action: ${JSON.stringify(_exhaustive)}`);
    }
  }

  return {
    actionType: action.type,
    actionable,
    nonActionableReason,
    stale,
    assumptions,
    before,
    after,
    delta: buildDelta(before, after),
  };
}
```

```typescript
// frontend/src/lib/stream-preview.test.ts

import { describe, it, expect } from 'vitest';
import {
  buildStreamChangePreview,
  parseAmount,
  formatAmount,
  addAmounts,
  subtractAmounts,
  compareAmounts,
  parseTime,
  formatTime,
  type CurrentStreamSnapshot,
} from './stream-preview';

const NOW = Date.parse('2024-06-01T00:00:00.000Z');

function makeSnapshot(overrides: Partial<CurrentStreamSnapshot> = {}): CurrentStreamSnapshot {
  return {
    remainingAmount: '1000',
    ratePerSecond: '0.0001',
    endTime: '2024-07-01T00:00:00.000Z',
    beneficiary: 'GBENEFICIARY1',
    status: 'active',
    updatedAt: '2024-06-01T00:00:00.000Z',
    ledger: 100,
    ...overrides,
  };
}

describe('amount helpers', () => {
  it('parses and formats at 7-decimal precision', () => {
    expect(parseAmount('1.1234567')).toBe(11234567n);
    expect(formatAmount(11234567n)).toBe('1.1234567');
    expect(formatAmount(10000000n)).toBe('1');
    expect(formatAmount(0n)).toBe('0');
  });

  it('rounds/truncates beyond 7 decimals on parse', () => {
    // Extra digits are truncated (not rounded) to 7 decimals.
    expect(parseAmount('1.12345678')).toBe(11234567n);
    expect(parseAmount('0.00000009')).toBe(0n);
  });

  it('handles negative amounts', () => {
    expect(parseAmount('-1.5')).toBe(-15000000n);
    expect(formatAmount(-15000000n)).toBe('-1.5');
  });

  it('adds and subtracts without floating point drift', () => {
    expect(addAmounts('0.1', '0.2')).toBe('0.3');
    expect(subtractAmounts('0.3', '0.1')).toBe('0.2');
    expect(addAmounts('9999999.9999999', '0.0000001')).toBe('10000000');
  });

  it('compares amounts', () => {
    expect(compareAmounts('1', '2')).toBe(-1);
    expect(compareAmounts('2', '2')).toBe(0);
    expect(compareAmounts('3', '2')).toBe(1);
  });

  it('rejects invalid amounts', () => {
    expect(() => parseAmount('abc')).toThrow();
    expect(() => parseAmount('')).toThrow();
    expect(() => parseAmount(Number.NaN)).toThrow();
  });
});

describe('time helpers', () => {
  it('parses ISO and epoch ms', () => {
    expect(parseTime('2024-06-01T00:00:00.000Z')).toBe(NOW);
    expect(parseTime(NOW)).toBe(NOW);
    expect(parseTime(String(NOW))).toBe(NOW);
  });

  it('formats to ISO', () => {
    expect(formatTime(NOW)).toBe('2024-06-01T00:00:00.000Z');
  });

  it('rejects invalid times', () => {
    expect(() => parseTime('not-a-date')).toThrow();
    expect(() => parseTime('')).toThrow();
  });
});

describe('buildStreamChangePreview', () => {
  it('does not mutate inputs', () => {
    const snapshot = makeSnapshot();
    const frozen = JSON.parse(JSON.stringify(snapshot));
    const action = { type: 'top-up' as const, amount: '500' };
    buildStreamChangePreview(snapshot, action, { maxAgeMs: 1000, now: NOW });
    expect(snapshot).toEqual(frozen);
    expect(action).toEqual({ type: 'top-up', amount: '500' });
  });

  describe('top-up', () => {
    it('increases remaining amount and leaves rate/end time unchanged', () => {
      const preview = buildStreamChangePreview(
        makeSnapshot(),
        { type: 'top-up', amount: '500' },
        { maxAgeMs: 1000, now: NOW },
      );
      expect(preview.actionType).toBe('top-up');
      expect(preview.actionable).toBe(true);
      expect(preview.before.remainingAmount).toBe('1000');
      expect(preview.after.remainingAmount).toBe('1500');
      expect(preview.after.ratePerSecond).toBe(preview.before.ratePerSecond);
      expect(preview.after.endTime).toBe(preview.before.endTime);
      expect(preview.delta.remainingAmount).toBe('500');
      expect(preview.assumptions.length).toBeGreaterThan(0);
    });

    it('handles 7-decimal rounding boundaries', () => {
      const preview = buildStreamChangePreview(
        makeSnapshot({ remainingAmount: '0.0000001' }),
        { type: 'top-up', amount: '0.0000001' },
        { maxAgeMs: 1000, now: NOW },
      );
      expect(preview.after.remainingAmount).toBe('0.0000002');
      expect(preview.delta.remainingAmount).toBe('0.0000001');
    });

    it('rejects non-positive top-up amounts', () => {
      expect(() =>
        buildStreamChangePreview(makeSnapshot(), { type: 'top-up', amount: '0' }),
      ).toThrow();
      expect(() =>
        buildStreamChangePreview(makeSnapshot(), { type: 'top-up', amount: '-1' }),
      ).toThrow();
    });
  });

  describe('schedule-update', () => {
    it('updates end time and derives rate when omitted', () => {
      const newEnd = '2024-06-02T00:00:00.000Z';
      const preview = buildStreamChangePreview(
        makeSnapshot({ remainingAmount: '86400' }),
        { type: 'schedule-update', endTime: newEnd },
        { maxAgeMs: 1000, now: NOW },
      );
      expect(preview.after.endTime).toBe(newEnd);
      // 86400 over 86400 seconds = 1 per second.
      expect(preview.after.ratePerSecond).toBe('1');
      expect(preview.assumptions.some((a) => a.includes('derived'))).toBe(true);
    });

    it('uses provided rate', () => {
      const preview = buildStreamChangePreview(
        makeSnapshot(),
        { type: 'schedule-update', endTime: '2024-06-02T00:00:00.000Z', ratePerSecond: '0.5' },
        { maxAgeMs: 1000, now: NOW },
      );
      expect(preview.after.ratePerSecond).toBe('0.5');
    });

    it('rejects end time not after current end time', () => {
      expect(() =>
        buildStreamChangePreview(
          makeSnapshot(),
          { type: 'schedule-update', endTime: '2024-06-01T00:00:00.000Z' },
          { maxAgeMs: 1000, now: NOW },
        ),
      ).toThrow();
    });

    it('rejects non-positive provided rate', () => {
      expect(() =>
        buildStreamChangePreview(
          makeSnapshot(),
          { type: 'schedule-update', endTime: '2024-06-02T00:00:00.000Z', ratePerSecond: '0' },
          { maxAgeMs: 1000, now: NOW },
        ),
      ).toThrow();
    });
  });

  describe('beneficiary-change', () => {
    it('changes beneficiary only', () => {
      const preview = buildStreamChangePreview(
        makeSnapshot(),
        { type: 'beneficiary-change', beneficiary: 'GNEW' },
        { maxAgeMs: 1000, now: NOW },
      );
      expect(preview.after.beneficiary).toBe('GNEW');
      expect(preview.after.remainingAmount).toBe(preview.before.remainingAmount);
      expect(preview.delta.beneficiaryChanged).toBe(true);
    });

    it('rejects unchanged beneficiary', () => {
      expect(() =>
        buildStreamChangePreview(makeSnapshot(), {
          type: 'beneficiary-change',
          beneficiary: 'GBENEFICIARY1',
        }),
      ).toThrow();
    });
  });

  describe('cancellation', () => {
    it('marks status canceled', () => {
      const preview = buildStreamChangePreview(
        makeSnapshot(),
        { type: 'cancellation' },
        { maxAgeMs: 1000, now: NOW },
      );
      expect(preview.after.status).toBe('canceled');
      expect(preview.delta.statusChanged).toBe(true);
    });
  });

  describe('stale snapshots', () => {
    it('flags stale when older than maxAgeMs', () => {
      const preview = buildStreamChangePreview(
        makeSnapshot({ updatedAt: '2024-05-31T23:00:00.000Z' }),
        { type: 'top-up', amount: '1' },
        { maxAgeMs: 60_000, now: NOW },
      );
      expect(preview.stale).toBe(true);
    });

    it('does not flag fresh snapshots', () => {
      const preview = buildStreamChangePreview(
        makeSnapshot({ updatedAt: '2024-05-31T23:59:30.000Z' }),
        { type: 'top-up', amount: '1' },
        { maxAgeMs: 60_000, now: NOW },
      );
      expect(preview.stale).toBe(false);
    });

    it('flags stale by ledger age', () => {
      const preview = buildStreamChangePreview(
        makeSnapshot({ ledger: 100 }),
        { type: 'top-up', amount: '1' },
        { currentLedger: 200, maxLedgerAge: 50 },
      );
      expect(preview.stale).toBe(true);
    });

    it('is not stale without a threshold', () => {
      const preview = buildStreamChangePreview(makeSnapshot(), {
        type: 'top-up',
        amount: '1',
      });
      expect(preview.stale).toBe(false);
    });
  });

  describe('canceled/closed streams', () => {
    it.each(['canceled', 'cancelled', 'closed'])(
      'treats %s streams as non-actionable',
      (status) => {
        const preview = buildStreamChangePreview(
          makeSnapshot({ status }),
          { type: 'top-up', amount: '1' },
          { maxAgeMs: 1000, now: NOW },
        );
        expect(preview.actionable).toBe(false);
        expect(preview.nonActionableReason).toBeDefined();
        expect(preview.after).toEqual(preview.before);
        expect(preview.delta.remainingAmount).toBe('0');
        expect(preview.assumptions.some((a) => a.includes('canceled/closed'))).toBe(true);
      },
    );
  });
});