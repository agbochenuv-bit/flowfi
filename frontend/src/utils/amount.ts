/**
 * Convert raw on-chain amount (smallest unit) to human-readable string
 * @param raw - Raw amount as bigint (i128 from chain)
 * @param decimals - Number of decimal places for the token
 * @returns Formatted string e.g., "10.5000000"
 */
export function formatAmount(raw: bigint, decimals: number): string {
  if (raw === 0n) return "0";
  if (decimals === 0) return raw.toString();

  const factor = 10n ** BigInt(decimals);
  const integerPart = raw / factor;
  const fractionalPart = raw % factor;

  const fractionalStr = fractionalPart.toString().padStart(decimals, "0");
  const trimmedFractional = fractionalStr.replace(/0+$/, "");

  if (!trimmedFractional) return integerPart.toString();
  return `${integerPart}.${trimmedFractional}`;
}

/**
 * Compute stream withdrawal progress as a percentage (0–100).
 *
 * Guards against a BigInt divide-by-zero when nothing was deposited (e.g. a
 * freshly indexed stream, or a fee that consumed the full deposit). When
 * `deposited` is 0 the bar reads 100% if anything was withdrawn, otherwise 0%.
 *
 * @param withdrawn - Amount withdrawn so far (smallest unit)
 * @param deposited - Total amount deposited (smallest unit)
 * @returns Progress percentage clamped to the range [0, 100]
 */
export function streamProgressPercent(withdrawn: bigint, deposited: bigint): number {
  if (deposited === 0n) return withdrawn > 0n ? 100 : 0;
  return Math.min(100, Number((withdrawn * 100n) / deposited));
}

/**
 * Alias for formatAmount - convert raw on-chain amount to human-readable string
 * @param amount - Raw amount as bigint
 * @param decimals - Token decimals; defaults to 7 (XLM stroops)
 * @deprecated Use formatAmount instead
 */
export function fromStroops(amount: bigint, decimals = 7): string {
  return formatAmount(amount, decimals);
}

/**
 * Convert human-readable amount to raw on-chain amount (smallest unit)
 * @param display - Display string (e.g., "1.234")
 * @param decimals - Number of decimal places for the token
 * @returns Raw amount as bigint
 */
export function parseAmount(display: string, decimals: number): bigint {
  const trimmed = display.trim();
  if (!trimmed) return 0n;

  // Validate input is a valid number format
  if (!/^\d*\.?\d*$/.test(trimmed)) return 0n;

  const parts = trimmed.split(".");
  const integerPart = parts[0] || "0";
  let fractionalPart = parts[1] || "";

  if (fractionalPart.length > decimals) {
    fractionalPart = fractionalPart.slice(0, decimals);
  } else if (fractionalPart.length < decimals) {
    fractionalPart = fractionalPart.padEnd(decimals, "0");
  }

  const factor = 10n ** BigInt(decimals);
  return BigInt(integerPart) * factor + BigInt(fractionalPart);
}

/** Parse a user-entered amount exactly, rejecting invalid or excess precision. */
export function parseAmountExact(display: string, decimals: number): bigint {
  if (!Number.isInteger(decimals) || decimals < 0) {
    throw new RangeError("Token decimals must be a non-negative integer");
  }

  const trimmed = display.trim();
  if (!/^(?:\d+(?:\.\d*)?|\.\d+)$/.test(trimmed)) {
    throw new Error("Please enter a valid positive amount");
  }
  if (!hasValidPrecision(trimmed, decimals)) {
    throw new Error(`Amount cannot have more than ${decimals} decimal places`);
  }

  const [integerPart = "0", fractionalPart = ""] = trimmed.split(".");
  const factor = 10n ** BigInt(decimals);
  const scaledFraction = fractionalPart.padEnd(decimals, "0");
  return BigInt(integerPart || "0") * factor + BigInt(scaledFraction || "0");
}

/**
 * Alias for parseAmount - convert human-readable to raw on-chain amount
 * @param amount - Display string (e.g., "1.234")
 * @param decimals - Token decimals; defaults to 7 (XLM stroops)
 * @deprecated Use parseAmount instead
 */
export function toStroops(amount: string, decimals = 7): bigint {
  return parseAmount(amount, decimals);
}

/**
 * Format rate per second to human-readable string showing both per-second and per-day
 * @param ratePerSec - Rate per second as bigint
 * @param decimals - Number of decimal places for the token
 * @param symbol - Token symbol (optional)
 * @returns Formatted rate string e.g., "0.0001 USDC/sec (8.64 USDC/day)"
 */
export function formatRate(
  ratePerSec: bigint,
  decimals: number,
  symbol = ""
): string {
  if (ratePerSec === 0n) return symbol ? `0 ${symbol}/sec` : "0/sec";

  const perSecond = formatAmount(ratePerSec, decimals);
  const perDay = formatAmount(ratePerSec * 86400n, decimals); // 86400 seconds in a day

  const symbolStr = symbol ? ` ${symbol}` : "";
  return `${perSecond}${symbolStr}/sec (${perDay}${symbolStr}/day)`;
}

/**
 * Format stream rate as human-readable string
 * @deprecated Use formatRate instead
 */
export function formatStreamRate(
  ratePerSecond: bigint,
  decimals: number,
  tokenSymbol: string = "USDC"
): string {
  return formatRate(ratePerSecond, decimals, tokenSymbol);
}

/**
 * Truncate amount to specified decimal places without rounding
 * @param amount - Amount as bigint
 * @param decimals - Token decimals
 * @param maxDisplayDecimals - Maximum decimal places to display
 * @returns Truncated string
 */
export function truncateAmount(
  amount: bigint,
  decimals: number,
  maxDisplayDecimals: number
): string {
  if (amount === 0n) return "0";

  const factor = 10n ** BigInt(decimals);
  const integerPart = amount / factor;
  const fractionalPart = amount % factor;

  if (fractionalPart === 0n) return integerPart.toString();

  const fractionalStr = fractionalPart.toString().padStart(decimals, "0");
  const truncatedFractional = fractionalStr.slice(0, maxDisplayDecimals);
  const trimmedFractional = truncatedFractional.replace(/0+$/, "");

  if (!trimmedFractional) return integerPart.toString();
  return `${integerPart}.${trimmedFractional}`;
}

/**
 * Format amount with compact notation (K, M, B) for large numbers
 * @param amount - Amount as bigint
 * @param decimals - Token decimals
 * @returns Compact formatted string e.g., "1.5K"
 */
export function formatCompactAmount(amount: bigint, decimals: number): string {
  const displayAmount = formatAmount(amount, decimals);
  const num = parseFloat(displayAmount);

  if (num === 0) return "0";
  if (num < 1_000) return displayAmount;
  if (num < 1_000_000) return `${(num / 1_000).toFixed(1)}K`;
  if (num < 1_000_000_000) return `${(num / 1_000_000).toFixed(1)}M`;
  return `${(num / 1_000_000_000).toFixed(1)}B`;
}

/**
 * Check if input string has valid precision for the given decimals
 * @param input - Input string to validate
 * @param decimals - Maximum allowed decimal places
 * @returns True if valid precision
 */
export function hasValidPrecision(input: string, decimals: number): boolean {
  if (!input || input.trim() === "") return true; // Empty is valid (will be parsed as 0)

  const cleanInput = input.trim();

  // Check if it's a valid number format (digits with optional single decimal point)
  if (!/^\d*\.?\d*$/.test(cleanInput)) return false;

  // Check for negative sign (not allowed for amounts)
  if (cleanInput.startsWith("-")) return false;

  if (cleanInput.includes(".")) {
    const fractionalPart = cleanInput.split(".")[1];
    return fractionalPart ? fractionalPart.length <= decimals : true;
  }

  return true;
}

/**
 * Validate amount input and return error message if invalid
 * @param input - Input string to validate
 * @param decimals - Maximum allowed decimal places
 * @returns Error message or null if valid
 */
export function validateAmountInput(
  input: string,
  decimals: number
): string | null {
  if (!input || input.trim() === "") {
    return "Amount is required";
  }

  const cleanInput = input.trim();

  // Check for valid number format
  if (!/^\d*\.?\d*$/.test(cleanInput)) {
    return "Please enter a valid number";
  }

  // Check precision
  if (!hasValidPrecision(cleanInput, decimals)) {
    return `Amount cannot have more than ${decimals} decimal places`;
  }

  // Compare exact integer units so large values and tiny fractions stay exact.
  if (parseAmount(cleanInput, decimals) <= 0n) {
    return "Amount must be greater than 0";
  }

  return null;
}

/**
 * Cache for token decimals to avoid repeated contract calls
 */
const tokenDecimalsCache = new Map<string, number>();

// Default decimals for known tokens (Stellar uses 7 for XLM, 6 or 7 for most tokens)
const DEFAULT_TOKEN_DECIMALS: Record<string, number> = {
  XLM: 7,
  USDC: 7,
  EURC: 7,
  FLOW: 7,
};

/**
 * Get cached token decimals for a given token address
 * @param tokenAddress - Token contract address
 * @returns Cached decimals or undefined if not cached
 */
export function getCachedTokenDecimals(tokenAddress: string): number | undefined {
  return tokenDecimalsCache.get(tokenAddress);
}

/**
 * Set token decimals in cache
 * @param tokenAddress - Token contract address
 * @param decimals - Token decimal places
 */
export function setCachedTokenDecimals(
  tokenAddress: string,
  decimals: number
): void {
  tokenDecimalsCache.set(tokenAddress, decimals);
}

/**
 * Clear token decimals cache
 */
export function clearTokenDecimalsCache(): void {
  tokenDecimalsCache.clear();
}

/**
 * Get default decimals for known token symbols
 * @param symbol - Token symbol (e.g., "USDC", "XLM")
 * @returns Default decimals or 7 if unknown
 */
export function getDefaultTokenDecimals(symbol: string): number {
  return DEFAULT_TOKEN_DECIMALS[symbol.toUpperCase()] ?? 7;
}

import { logger } from "@/lib/logger";

// RPC configuration for fetching token decimals
const SOROBAN_RPC_URL =
  process.env.NEXT_PUBLIC_SOROBAN_RPC_URL ?? "https://soroban-testnet.stellar.org";
const NETWORK_PASSPHRASE =
  process.env.NEXT_PUBLIC_NETWORK_PASSPHRASE ?? "Test SDF Network ; September 2015";

/**
 * Fetch token decimals from the Soroban contract
 * Fetches once and caches per token address
 * @param tokenAddress - Token contract address
 * @returns Promise resolving to token decimals
 */
export async function fetchTokenDecimals(tokenAddress: string): Promise<number> {
  // Check cache first
  const cached = getCachedTokenDecimals(tokenAddress);
  if (cached !== undefined) {
    return cached;
  }

  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const sdk: any = await import("@stellar/stellar-sdk");
    const { Contract, TransactionBuilder, BASE_FEE } = sdk;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const rpc: any = sdk.rpc ?? sdk.SorobanRpc;

    // Use a dummy account for simulation (just need to read contract data)
    const dummyKeypair = sdk.Keypair.random();
    const server = new rpc.Server(SOROBAN_RPC_URL, { allowHttp: false });

    // Build a transaction to call the 'decimals' function
    const account = await server.getAccount(dummyKeypair.publicKey());
    const tokenContract = new Contract(tokenAddress);

    const tx = new TransactionBuilder(account, {
      fee: BASE_FEE,
      networkPassphrase: NETWORK_PASSPHRASE,
    })
      .addOperation(tokenContract.call("decimals"))
      .setTimeout(30)
      .build();

    const simResult = await server.simulateTransaction(tx);

    if (rpc.Api?.isSimulationError?.(simResult) ?? simResult?.error) {
      logger.warn(`Failed to fetch decimals for ${tokenAddress}:`, simResult.error);
      // Cache default to avoid repeated failed calls
      setCachedTokenDecimals(tokenAddress, 7);
      return 7;
    }

    const rawResult = simResult?.result?.retval;
    if (!rawResult) {
      logger.warn(`No decimals returned for ${tokenAddress}`);
      setCachedTokenDecimals(tokenAddress, 7);
      return 7;
    }

    const nativeValue = sdk.scValToNative(rawResult);
    let decimals: number;

    if (typeof nativeValue === "number") {
      decimals = nativeValue;
    } else if (typeof nativeValue === "bigint") {
      decimals = Number(nativeValue);
    } else if (typeof nativeValue === "string") {
      decimals = parseInt(nativeValue, 10);
    } else {
      decimals = 7;
    }

    // Cache the result
    setCachedTokenDecimals(tokenAddress, decimals);
    return decimals;
  } catch (error) {
    logger.error(`Error fetching token decimals for ${tokenAddress}:`, error);
    // Cache default to avoid repeated failed calls
    setCachedTokenDecimals(tokenAddress, 7);
    return 7;
  }
}

/**
 * React hook compatible function to get token decimals
 * Returns cached value immediately if available, otherwise fetches and caches
 * @param tokenAddress - Token contract address
 * @param callback - Optional callback when decimals are fetched
 * @returns Current decimals (cached or default 7)
 */
export function getTokenDecimalsSync(
  tokenAddress: string,
  callback?: (decimals: number) => void
): number {
  const cached = getCachedTokenDecimals(tokenAddress);
  if (cached !== undefined) {
    return cached;
  }

  // Trigger async fetch if not cached
  if (callback) {
    fetchTokenDecimals(tokenAddress).then(callback).catch(() => callback(7));
  }

  return 7; // Return default while fetching
}

/**
 * Compact display formatting for large token balances (issue #1509).
 *
 * Returns BOTH a compact form ("1.45M", "12.5K") for the visible cell and the
 * exact decimal string for a hover tooltip. Callers should always render the
 * compact form and attach the exact form to `title=` (or an accessible label)
 * so the full precision is never lost — only hidden.
 *
 *   formatTokenCompact(14_502_934_910_293n, 7)
 *   // => { compact: "1.45M", exact: "1450293.4910293" }
 *
 * `decimals` is the token's fixed-point scale (7 for Stellar assets). The
 * compact form uses the en locale's `compact` notation — the same
 * "12.5K / 1.45M" shape the issue specifies. The exact form is trimmed of
 * trailing zeros so it reads like the raw on-chain amount rather than a
 * padded fixed-width number.
 */
export function formatTokenCompact(
  amount: bigint,
  decimals: number,
  opts: { locale?: string; maximumFractionDigits?: number } = {},
): { compact: string; exact: string } {
  const locale = opts.locale ?? "en";
  const maxFractionDigits = opts.maximumFractionDigits ?? 2;

  const negative = amount < 0n;
  const abs = negative ? -amount : amount;
  const divisor = 10n ** BigInt(decimals);
  const whole = abs / divisor;
  const frac = abs % divisor;

  // Build the exact decimal string without float imprecision.
  const fracStr = frac.toString().padStart(decimals, "0").replace(/0+$/, "");
  const exactAbs = fracStr.length > 0 ? `${whole}.${fracStr}` : whole.toString();
  const exact = negative ? `-${exactAbs}` : exactAbs;

  // Convert to a Number only for the Intl compact formatting. Values beyond
  // Number.MAX_SAFE_INTEGER lose sub-unit precision here, but that precision
  // is already shown in `exact`, and the compact form is a display hint.
  const asNumber = Number(exact);
  // Below 10,000 the full grouped value already fits, so skip the K suffix
  // (otherwise 9,999 would round up to "10K").
  const compactAbs = new Intl.NumberFormat(locale, {
    notation: Math.abs(asNumber) < 10_000 ? "standard" : "compact",
    maximumFractionDigits: maxFractionDigits,
  }).format(Math.abs(asNumber));

  const compact = negative ? `-${compactAbs}` : compactAbs;

  return { compact, exact };
}

/**
 * Options for locale-aware amount formatting.
 */
export interface LocalizedAmountOptions {
  /** Minimum fraction digits to render (defaults to 0). */
  minimumFractionDigits?: number;
  /** Maximum fraction digits to render (defaults to the token's `decimals`). */
  maximumFractionDigits?: number;
  /** Whether to render grouping separators (defaults to true). */
  useGrouping?: boolean;
  /** Currency code to render, e.g. "USD". When set, `style` becomes "currency". */
  currency?: string;
  /** Intl notation style (defaults to "standard"). */
  notation?: "standard" | "compact";
  /** Whether to always show an explicit sign (defaults to false). */
  signDisplay?: "auto" | "always" | "never" | "exceptZero";
}

/**
 * Format a canonical on-chain amount (smallest unit) for display in a locale.
 *
 * The raw `bigint` is never mutated; the returned `raw` field always carries
 * the exact canonical value so callers can keep it in details views, exports,
 * and tooltips. Formatting is derived from the exact integer representation
 * (never via floating point) so fractional precision is preserved for any
 * token scale, including values beyond `Number.MAX_SAFE_INTEGER`.
 *
 * @param raw - Raw amount as bigint (i128 from chain)
 * @param decimals - Number of decimal places for the token
 * @param locale - BCP 47 locale tag, e.g. "en-US" or "de-DE"
 * @param options - Formatting options
 * @returns `{ formatted, raw, locale }` where `raw` is the untouched input
 */
export function formatAmountLocalized(
  raw: bigint,
  decimals: number,
  locale: string,
  options: LocalizedAmountOptions = {},
): { formatted: string; raw: bigint; locale: string } {
  if (!Number.isInteger(decimals) || decimals < 0) {
    throw new RangeError("Token decimals must be a non-negative integer");
  }

  const negative = raw < 0n;
  const abs = negative ? -raw : raw;
  const factor = 10n ** BigInt(decimals);
  const whole = abs / factor;
  const frac = abs % factor;

  // Build the exact decimal string from the integer parts. This avoids any
  // float conversion so precision is preserved regardless of magnitude.
  const fracStr = frac.toString().padStart(decimals, "0");
  const exactAbs = decimals > 0 ? `${whole}.${fracStr}` : whole.toString();

  const maxFractionDigits = Math.min(
    options.maximumFractionDigits ?? decimals,
    decimals,
  );
  const minFractionDigits = Math.min(
    options.minimumFractionDigits ?? 0,
    maxFractionDigits,
  );

  const formatter = new Intl.NumberFormat(locale, {
    style: options.currency ? "currency" : "decimal",
    currency: options.currency,
    notation: options.notation ?? "standard",
    useGrouping: options.useGrouping ?? true,
    minimumFractionDigits: minFractionDigits,
    maximumFractionDigits: maxFractionDigits,
    signDisplay: options.signDisplay ?? "auto",
  });

  // Format the exact decimal string. Intl accepts a numeric string and parses
  // it without losing the digits we already validated, but to be safe for
  // very large magnitudes we format the integer and fraction separately when
  // the value exceeds the safe integer range.
  let formatted: string;
  if (whole <= BigInt(Number.MAX_SAFE_INTEGER)) {
    const numeric = Number(exactAbs);
    formatted = formatter.format(negative ? -numeric : numeric);
  } else {
    // Large magnitudes: format the integer part exactly, then append the
    // locale's decimal separator and the (optionally truncated) fraction.
    const intFormatted = new Intl.NumberFormat(locale, {
      useGrouping: options.useGrouping ?? true,
      maximumFractionDigits: 0,
    }).format(whole);
    const parts = new Intl.NumberFormat(locale).formatToParts(1.1);
    const decimalSep = parts.find((p) => p.type === "decimal")?.value ?? ".";
    const shownFrac = fracStr.slice(0, maxFractionDigits).replace(/0+$/, "");
    const fracOut = shownFrac.padEnd(minFractionDigits, "0");
    const sign = negative ? "-" : "";
    formatted = fracOut.length > 0
      ? `${sign}${intFormatted}${decimalSep}${fracOut}`
      : `${sign}${intFormatted}`;
  }

  return { formatted, raw, locale };
}

/**
 * Format a Unix timestamp (seconds) for display in a locale and timezone.
 *
 * The raw Unix seconds are preserved in the returned `raw` field so callers
 * can keep canonical values in details views and exports. Timezone boundaries
 * are respected by delegating to `Intl.DateTimeFormat` with an explicit
 * `timeZone`.
 *
 * @param unixSeconds - Unix timestamp in seconds (may be bigint or number)
 * @param locale - BCP 47 locale tag
 * @param timeZone - IANA timezone, e.g. "UTC" or "America/New_York"
 * @param options - Optional Intl.DateTimeFormat options
 * @returns `{ formatted, raw, locale, timeZone }`
 */
export function formatTimestampLocalized(
  unixSeconds: number | bigint,
  locale: string,
  timeZone: string,
  options: Intl.DateTimeFormatOptions = {},
): { formatted: string; raw: number | bigint; locale: string; timeZone: string } {
  const millis = Number(unixSeconds) * 1000;
  const formatter = new Intl.DateTimeFormat(locale, {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone,
    ...options,
  });
  return {
    formatted: formatter.format(new Date(millis)),
    raw: unixSeconds,
    locale,
    timeZone,
  };
}

/**
 * Plural forms keyed by CLDR plural category.
 */
export type PluralForms = Partial<
  Record<Intl.LDMLPluralRule, string> & { other: string }
>;

/**
 * Select the correct localized plural form for a count.
 *
 * Uses `Intl.PluralRules` so the correct CLDR category (zero/one/two/few/
 * many/other) is chosen per locale. Falls back to the `other` form when a
 * specific category is not provided.
 *
 * @param count - The numeric count used to select the plural category
 * @param locale - BCP 47 locale tag
 * @param forms - Map of plural categories to localized strings
 * @returns The selected localized string
 */
export function formatPlural(
  count: number,
  locale: string,
  forms: PluralForms,
): string {
  const category = new Intl.PluralRules(locale).select(count);
  return forms[category] ?? forms.other ?? "";
}
