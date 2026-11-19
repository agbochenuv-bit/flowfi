import { describe, it, expect } from 'vitest';
import {
  formatTokenAmount,
  formatFiat,
  formatDate,
  formatDateRange,
  parseTokenAmount,
} from './format';

describe('formatTokenAmount locale boundaries', () => {
  const supportedLocales = ['en-US', 'en-GB', 'de-DE', 'fr-FR', 'ja-JP'];

  it('keeps canonical token values unchanged across supported locales', () => {
    const canonical = '1234.5678';
    for (const locale of supportedLocales) {
      expect(formatTokenAmount(canonical, { locale })).toBe(canonical);
    }
  });

  it('does not apply locale grouping separators to token amounts', () => {
    for (const locale of supportedLocales) {
      const formatted = formatTokenAmount('1000000.5', { locale });
      expect(formatted).toBe('1000000.5');
      expect(formatted).not.toContain(',');
      expect(formatted).not.toContain('\u00a0');
      expect(formatted).not.toContain('.');
    }
  });

  it('round-trips token amounts through parse regardless of locale', () => {
    for (const locale of supportedLocales) {
      const formatted = formatTokenAmount('0.00000001', { locale });
      expect(parseTokenAmount(formatted)).toBe('0.00000001');
    }
  });

  it('rejects malformed token amounts instead of silently coercing', () => {
    expect(() => formatTokenAmount('1,234.5', { locale: 'en-US' })).toThrow();
    expect(() => formatTokenAmount('1.234,5', { locale: 'de-DE' })).toThrow();
  });
});

describe('formatFiat locale boundaries', () => {
  it('formats fiat per locale while preserving the underlying value', () => {
    expect(formatFiat(1234.5, { locale: 'en-US', currency: 'USD' })).toBe('$1,234.50');
    expect(formatFiat(1234.5, { locale: 'de-DE', currency: 'EUR' })).toBe('1.234,50\u00a0€');
  });

  it('handles negative and zero fiat values', () => {
    expect(formatFiat(0, { locale: 'en-US', currency: 'USD' })).toBe('$0.00');
    expect(formatFiat(-12.3, { locale: 'en-US', currency: 'USD' })).toBe('-$12.30');
  });
});

describe('formatDate timezone and DST boundaries', () => {
  const originalTz = process.env.TZ;

  afterEach(() => {
    process.env.TZ = originalTz;
  });

  it('renders the same calendar day across timezones for a UTC noon timestamp', () => {
    const ts = Date.UTC(2024, 2, 10, 12, 0, 0);
    for (const tz of ['UTC', 'America/New_York', 'Europe/Berlin', 'Asia/Tokyo']) {
      process.env.TZ = tz;
      expect(formatDate(ts, { locale: 'en-US', timeZone: 'UTC' })).toBe('2024-03-10');
    }
  });

  it('handles the spring-forward DST transition without shifting the day', () => {
    process.env.TZ = 'America/New_York';
    const beforeDst = Date.UTC(2024, 2, 10, 6, 59, 0);
    const afterDst = Date.UTC(2024, 2, 10, 7, 1, 0);
    expect(formatDate(beforeDst, { locale: 'en-US', timeZone: 'America/New_York' })).toBe('2024-03-10');
    expect(formatDate(afterDst, { locale: 'en-US', timeZone: 'America/New_York' })).toBe('2024-03-10');
  });

  it('handles the fall-back DST transition without shifting the day', () => {
    process.env.TZ = 'America/New_York';
    const beforeFallback = Date.UTC(2024, 10, 3, 5, 59, 0);
    const afterFallback = Date.UTC(2024, 10, 3, 6, 1, 0);
    expect(formatDate(beforeFallback, { locale: 'en-US', timeZone: 'America/New_York' })).toBe('2024-11-03');
    expect(formatDate(afterFallback, { locale: 'en-US', timeZone: 'America/New_York' })).toBe('2024-11-03');
  });

  it('rejects invalid timestamps', () => {
    expect(() => formatDate(Number.NaN, { locale: 'en-US', timeZone: 'UTC' })).toThrow();
  });
});

describe('formatDateRange transition boundaries', () => {
  it('treats the range as inclusive of both endpoints', () => {
    const start = Date.UTC(2024, 0, 1);
    const end = Date.UTC(2024, 0, 31);
    expect(formatDateRange(start, end, { locale: 'en-US', timeZone: 'UTC' })).toBe('2024-01-01 – 2024-01-31');
  });

  it('handles month rollover', () => {
    const start = Date.UTC(2024, 0, 31);
    const end = Date.UTC(2024, 1, 1);
    expect(formatDateRange(start, end, { locale: 'en-US', timeZone: 'UTC' })).toBe('2024-01-31 – 2024-02-01');
  });

  it('handles year rollover', () => {
    const start = Date.UTC(2023, 11, 31);
    const end = Date.UTC(2024, 0, 1);
    expect(formatDateRange(start, end, { locale: 'en-US', timeZone: 'UTC' })).toBe('2023-12-31 – 2024-01-01');
  });

  it('handles leap-day boundaries', () => {
    const start = Date.UTC(2024, 1, 28);
    const end = Date.UTC(2024, 1, 29);
    expect(formatDateRange(start, end, { locale: 'en-US', timeZone: 'UTC' })).toBe('2024-02-28 – 2024-02-29');
  });

  it('rejects inverted ranges', () => {
    const start = Date.UTC(2024, 0, 31);
    const end = Date.UTC(2024, 0, 1);
    expect(() => formatDateRange(start, end, { locale: 'en-US', timeZone: 'UTC' })).toThrow();
  });
});
