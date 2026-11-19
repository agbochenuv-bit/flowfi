import { describe, it, expect } from 'vitest';

/**
 * Regression suite for locale and timezone boundary handling.
 *
 * These tests guard against financial display errors caused by locale
 * formatting, daylight-saving transitions, and date-range boundaries.
 * Canonical token values (raw amounts / ISO timestamps) must remain
 * unchanged regardless of the display locale or timezone.
 */

const SUPPORTED_LOCALES = ['en-US', 'en-GB', 'de-DE', 'fr-FR', 'ja-JP'] as const;

// Canonical token values are the source of truth and must never be mutated
// by display formatting.
const CANONICAL_TOKENS = [
  { raw: '0', decimals: 18 },
  { raw: '1', decimals: 18 },
  { raw: '1000000000000000000', decimals: 18 },
  { raw: '1234567890123456789', decimals: 18 },
  { raw: '1000000', decimals: 6 },
] as const;

function formatToken(raw: string, decimals: number, locale: string): string {
  const negative = raw.startsWith('-');
  const digits = negative ? raw.slice(1) : raw;
  const padded = digits.padStart(decimals + 1, '0');
  const whole = padded.slice(0, padded.length - decimals) || '0';
  const fraction = decimals > 0 ? padded.slice(padded.length - decimals) : '';
  const trimmedFraction = fraction.replace(/0+$/, '');
  const wholeNumber = Number(whole);
  const formattedWhole = new Intl.NumberFormat(locale, {
    useGrouping: true,
    maximumFractionDigits: 0,
  }).format(wholeNumber);
  const sign = negative ? '-' : '';
  return trimmedFraction
    ? `${sign}${formattedWhole}.${trimmedFraction}`
    : `${sign}${formattedWhole}`;
}

function parseFormatted(formatted: string, locale: string): string {
  const parts = new Intl.NumberFormat(locale).formatToParts(1234.5);
  const group = parts.find((p) => p.type === 'group')?.value ?? ',';
  const decimal = parts.find((p) => p.type === 'decimal')?.value ?? '.';
  const normalized = formatted.split(group).join('').split(decimal).join('.');
  return normalized;
}

describe('locale formatting preserves canonical token values', () => {
  for (const locale of SUPPORTED_LOCALES) {
    it(`round-trips canonical tokens under ${locale}`, () => {
      for (const token of CANONICAL_TOKENS) {
        const formatted = formatToken(token.raw, token.decimals, locale);
        const parsed = parseFormatted(formatted, locale);
        const expected = (Number(token.raw) / 10 ** token.decimals).toString();
        expect(Number(parsed)).toBeCloseTo(Number(expected), 12);
      }
    });

    it(`does not mutate the raw token value under ${locale}`, () => {
      for (const token of CANONICAL_TOKENS) {
        const before = token.raw;
        formatToken(token.raw, token.decimals, locale);
        expect(token.raw).toBe(before);
      }
    });
  }

  it('formats zero consistently across locales', () => {
    for (const locale of SUPPORTED_LOCALES) {
      expect(parseFormatted(formatToken('0', 18, locale), locale)).toBe('0');
    }
  });

  it('preserves negative values across locales', () => {
    for (const locale of SUPPORTED_LOCALES) {
      const formatted = formatToken('-1000000000000000000', 18, locale);
      expect(parseFormatted(formatted, locale)).toBe('-1');
    }
  });
});

describe('timezone boundary and daylight-saving transitions', () => {
  // US DST spring-forward: 2024-03-10 02:00 local -> 03:00 local (America/New_York)
  // US DST fall-back: 2024-11-03 02:00 local -> 01:00 local (America/New_York)
  const DST_CASES = [
    { iso: '2024-03-10T06:59:59Z', tz: 'America/New_York', expected: '2024-03-10' },
    { iso: '2024-03-10T07:00:00Z', tz: 'America/New_York', expected: '2024-03-10' },
    { iso: '2024-11-03T05:59:59Z', tz: 'America/New_York', expected: '2024-11-03' },
    { iso: '2024-11-03T06:00:00Z', tz: 'America/New_York', expected: '2024-11-03' },
    { iso: '2024-12-31T23:59:59Z', tz: 'UTC', expected: '2024-12-31' },
    { iso: '2025-01-01T00:00:00Z', tz: 'UTC', expected: '2025-01-01' },
  ] as const;

  for (const { iso, tz, expected } of DST_CASES) {
    it(`renders ${iso} in ${tz} as ${expected}`, () => {
      const formatted = new Intl.DateTimeFormat('en-CA', {
        timeZone: tz,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
      }).format(new Date(iso));
      expect(formatted).toBe(expected);
    });
  }

  it('keeps the canonical ISO timestamp unchanged after formatting', () => {
    for (const { iso, tz } of DST_CASES) {
      const date = new Date(iso);
      new Intl.DateTimeFormat('en-US', { timeZone: tz }).format(date);
      expect(date.toISOString()).toBe(iso);
    }
  });

  it('handles a DST spring-forward gap without shifting the canonical instant', () => {
    // 02:30 local does not exist on 2024-03-10 in America/New_York.
    const instant = new Date('2024-03-10T07:30:00Z');
    const formatted = new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/New_York',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).format(instant);
    expect(formatted).toBe('03:30');
    expect(instant.toISOString()).toBe('2024-03-10T07:30:00.000Z');
  });
});

describe('date-range transition boundaries', () => {
  function inRange(date: Date, start: Date, end: Date): boolean {
    const t = date.getTime();
    return t >= start.getTime() && t <= end.getTime();
  }

  const start = new Date('2024-01-01T00:00:00Z');
  const end = new Date('2024-12-31T23:59:59Z');

  it('includes the start boundary', () => {
    expect(inRange(new Date('2024-01-01T00:00:00Z'), start, end)).toBe(true);
  });

  it('includes the end boundary', () => {
    expect(inRange(new Date('2024-12-31T23:59:59Z'), start, end)).toBe(true);
  });

  it('excludes instants just before the start', () => {
    expect(inRange(new Date('2023-12-31T23:59:59.999Z'), start, end)).toBe(false);
  });

  it('excludes instants just after the end', () => {
    expect(inRange(new Date('2025-01-01T00:00:00Z'), start, end)).toBe(false);
  });

  it('handles month rollover at the boundary', () => {
    const monthStart = new Date('2024-02-01T00:00:00Z');
    const monthEnd = new Date('2024-02-29T23:59:59Z');
    expect(inRange(new Date('2024-02-29T23:59:59Z'), monthStart, monthEnd)).toBe(true);
    expect(inRange(new Date('2024-03-01T00:00:00Z'), monthStart, monthEnd)).toBe(false);
  });

  it('handles year rollover at the boundary', () => {
    const yearStart = new Date('2024-01-01T00:00:00Z');
    const yearEnd = new Date('2024-12-31T23:59:59Z');
    expect(inRange(new Date('2025-01-01T00:00:00Z'), yearStart, yearEnd)).toBe(false);
    expect(inRange(new Date('2023-12-31T23:59:59Z'), yearStart, yearEnd)).toBe(false);
  });

  it('rejects an inverted range', () => {
    const invertedStart = new Date('2024-12-31T23:59:59Z');
    const invertedEnd = new Date('2024-01-01T00:00:00Z');
    expect(inRange(new Date('2024-06-01T00:00:00Z'), invertedStart, invertedEnd)).toBe(false);
  });
});
