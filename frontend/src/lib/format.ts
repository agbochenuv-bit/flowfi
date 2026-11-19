// Formatting helpers for token amounts and dates.
//
// Regression coverage for locale/timezone boundaries lives in
// `frontend/src/lib/format.test.ts`. The helpers below are intentionally
// locale-independent for canonical token values: `formatTokenAmount` and
// `parseTokenAmount` must produce identical output regardless of the host
// locale or timezone, so financial displays never drift.

export type TokenAmount = {
  raw: bigint;
  decimals: number;
};

const DEFAULT_LOCALE = "en-US";

/**
 * Format a raw token amount into a canonical, locale-independent string.
 *
 * Canonical output is always `integer.fraction` with exactly `decimals`
 * fractional digits and no grouping separators, so values are stable across
 * locales and safe to compare/snapshot in tests.
 */
export function formatTokenAmount(amount: TokenAmount): string {
  const { raw, decimals } = amount;
  if (decimals < 0 || !Number.isInteger(decimals)) {
    throw new RangeError(`Invalid decimals: ${decimals}`);
  }

  const negative = raw < 0n;
  const abs = negative ? -raw : raw;
  const base = 10n ** BigInt(decimals);
  const whole = abs / base;
  const fraction = abs % base;

  const wholeStr = whole.toString();
  const fractionStr = decimals > 0 ? fraction.toString().padStart(decimals, "0") : "";
  const body = decimals > 0 ? `${wholeStr}.${fractionStr}` : wholeStr;
  return negative ? `-${body}` : body;
}

/**
 * Parse a canonical token amount string back into a raw bigint.
 *
 * Accepts only the canonical form produced by `formatTokenAmount` (optional
 * leading `-`, digits, optional `.` followed by exactly `decimals` digits).
 * Rejects grouping separators and locale-specific decimal commas so that
 * locale-formatted input can never silently corrupt accounting values.
 */
export function parseTokenAmount(value: string, decimals: number): bigint {
  if (decimals < 0 || !Number.isInteger(decimals)) {
    throw new RangeError(`Invalid decimals: ${decimals}`);
  }

  const pattern =
    decimals > 0
      ? new RegExp(`^-?\\d+\\.\\d{${decimals}}$`)
      : /^-?\d+$/;

  if (!pattern.test(value)) {
    throw new Error(`Invalid token amount: ${value}`);
  }

  const negative = value.startsWith("-");
  const unsigned = negative ? value.slice(1) : value;
  const [whole, fraction = ""] = unsigned.split(".");
  const base = 10n ** BigInt(decimals);
  const raw = BigInt(whole) * base + (fraction ? BigInt(fraction) : 0n);
  return negative ? -raw : raw;
}

/**
 * Format a token amount for display in a specific locale.
 *
 * Display formatting may add grouping separators, but the numeric value is
 * derived from the canonical string so it never changes across locales.
 */
export function formatTokenAmountForDisplay(
  amount: TokenAmount,
  locale: string = DEFAULT_LOCALE,
): string {
  const canonical = formatTokenAmount(amount);
  const negative = canonical.startsWith("-");
  const unsigned = negative ? canonical.slice(1) : canonical;
  const [whole, fraction] = unsigned.split(".");

  const grouped = Number(whole).toLocaleString(locale, {
    useGrouping: true,
    maximumFractionDigits: 0,
  });

  const body = fraction ? `${grouped}.${fraction}` : grouped;
  return negative ? `-${body}` : body;
}

/**
 * Format an ISO timestamp as a date-only string in the given timezone.
 *
 * Uses `Intl.DateTimeFormat` with an explicit `timeZone` so output is stable
 * across host timezones and daylight-saving transitions.
 */
export function formatDateInTimeZone(
  iso: string,
  timeZone: string = "UTC",
  locale: string = DEFAULT_LOCALE,
): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    throw new Error(`Invalid date: ${iso}`);
  }

  return new Intl.DateTimeFormat(locale, {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

/**
 * Return the inclusive start and exclusive end of a UTC day for the given
 * ISO date string (`YYYY-MM-DD`). Handles month/year rollovers correctly.
 */
export function utcDayRange(isoDate: string): { start: string; end: string } {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(isoDate)) {
    throw new Error(`Invalid date: ${isoDate}`);
  }

  const start = new Date(`${isoDate}T00:00:00.000Z`);
  if (Number.isNaN(start.getTime())) {
    throw new Error(`Invalid date: ${isoDate}`);
  }

  const end = new Date(start.getTime() + 24 * 60 * 60 * 1000);
  return { start: start.toISOString(), end: end.toISOString() };
}
