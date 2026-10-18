/**
 * stream-validation.ts
 *
 * Canonical validation logic for stream creation.
 * Every entry point (wizard modal, full-page form, dashboard inline form)
 * MUST call these functions to enforce identical rules.
 *
 * Issue: Three divergent implementations had inconsistent validation —
 * only two of three checked recipient format, only one checked wallet balance.
 * This module closes those gaps.
 */

import { getDefaultTokenDecimals, hasValidPrecision, validateAmountInput } from "@/utils/amount";
import { isValidStellarPublicKey } from "@/lib/stellar";
import { SECONDS_PER_UNIT, TOKEN_ADDRESSES } from "@/lib/soroban";
import { isExpectedNetwork } from "@/lib/wallet";

// ─── Types ────────────────────────────────────────────────────────────────────

export type DurationUnit =
  | "seconds"
  | "minutes"
  | "hours"
  | "days"
  | "weeks"
  | "months";

/**
 * Minimum XLM that must stay in the wallet to cover Stellar base reserves.
 * The native token balance reported by the XLM SAC includes funds that are
 * locked as reserves, so they must be subtracted before offering a "Max".
 */
export const XLM_BASE_RESERVE = 1;

export interface StreamFormData {
  recipient: string;
  token: string;
  amount: string;
  duration: string;
  durationUnit: DurationUnit;
  descriptionTag?: string;
  /**
   * Optional free-text note attached to the stream transaction.
   *
   * The schedule step edits it and caps it at 28 UTF-8 bytes, the Stellar memo
   * limit; it is not otherwise validated.
   */
  memo?: string;
}

/**
 * Return the amount of a token the wallet can actually spend.
 *
 * For XLM the Stellar base reserve is subtracted so a "Max" deposit never
 * leaves the account below the minimum balance. Other tokens are returned
 * as-is. Returns `null` when no usable balance is known.
 */
export function getSpendableBalance(
  walletBalance: string | null | undefined,
  token?: string | null,
): number | null {
  if (walletBalance === null || walletBalance === undefined || walletBalance === "") {
    return null;
  }
  const parsed = parseFloat(walletBalance);
  if (isNaN(parsed)) return null;
  if ((token ?? "").toUpperCase() === "XLM") {
    return Math.max(parsed - XLM_BASE_RESERVE, 0);
  }
  return parsed;
}

export type StreamFormErrors = Partial<
  Record<keyof StreamFormData | "rate", string>
>;

export interface ValidationOptions {
  /**
   * When provided, only validate the fields relevant to the given wizard step:
   *   1 = Template (no field validation)
   *   2 = Recipient
   *   3 = Token
   *   4 = Amount
   *   5 = Schedule / Duration
   *
   * When omitted, validate ALL fields at once (flat-form mode).
   */
  step?: number;
  /** Display-formatted wallet balance for the selected token (e.g. "1000.5") */
  walletBalance?: string | null;
  /** Connected wallet network name, used to prevent signing on the wrong network. */
  walletNetwork?: string | null;
}

// ─── Individual field validators ──────────────────────────────────────────────

export function validateRecipient(
  recipient: string,
): string | null {
  const trimmed = recipient.trim();
  if (!trimmed) {
    return "Recipient address is required";
  }
  if (!isValidStellarPublicKey(trimmed)) {
    return "Invalid Stellar public key (must start with 'G' and be 56 characters)";
  }
  return null;
}

export function validateToken(token: string): string | null {
  if (!token || !token.trim()) {
    return "Please select a token";
  }
  const symbol = token.trim().toUpperCase();
  if (!(symbol in TOKEN_ADDRESSES)) {
    return "Unsupported token. Please select XLM, USDC, or EURC.";
  }
  return null;
}

export function validateAmount(
  amount: string,
  walletBalance?: string | null,
  token?: string | null,
  decimals = getDefaultTokenDecimals(token ?? ""),
): string | null {
  const trimmed = amount.trim();
  if (!trimmed) {
    return "Amount is required";
  }

  const parsed = parseFloat(trimmed);
  if (isNaN(parsed) || parsed <= 0) {
    return "Amount must be a positive number";
  }

  if (!hasValidPrecision(trimmed, decimals)) {
    return `Amount exceeds maximum precision (${decimals} decimal places)`;
  }

  // Use the richer validateAmountInput for extra safety
  const deepCheck = validateAmountInput(trimmed, decimals);
  if (deepCheck) {
    return deepCheck;
  }

  // Wallet balance check — applied uniformly across all entry points.
  // XLM reserves are subtracted so users cannot deposit funds that are
  // locked as the account's minimum balance.
  const available = getSpendableBalance(walletBalance, token);
  if (available !== null && parsed > available) {
    return "Amount exceeds wallet balance";
  }

  return null;
}

export function validateDuration(duration: string): string | null {
  const trimmed = duration.trim();
  if (!trimmed) {
    return "Duration is required";
  }
  const parsed = parseFloat(trimmed);
  if (isNaN(parsed) || parsed <= 0) {
    return "Duration must be a positive number";
  }
  return null;
}

// ─── Contract-aligned validators ──────────────────────────────────────────────
//
// These mirror the on-chain checks performed by the Soroban `create_stream`
// entry point so that predictable contract rejections are surfaced before the
// transaction is submitted to the wallet.

/** Maximum value of a signed 128-bit integer (i128), as used by the contract. */
const I128_MAX = 2n ** 127n - 1n;
/** Maximum value of an unsigned 64-bit integer (u64), as used for duration. */
const U64_MAX = 2n ** 64n - 1n;

/**
 * Predict the contract's `InvalidRate` rejection.
 *
 * The contract computes `rate_per_second = net_amount / duration` using i128
 * integer division and rejects when the result is zero (the stream would lock
 * tokens but never accrue). With the default fee configuration `net_amount`
 * equals `amount`, so we use the raw amount for the prediction.
 *
 * This also surfaces i128 amount overflow and u64 duration overflow before the
 * transaction reaches the wallet.
 *
 * @returns An error message when the stream would be rejected, or `null` when
 *          the combination is valid (or when the inputs are empty/invalid —
 *          those cases are handled by the dedicated field validators).
 */
export function validateRate(
  amount: string,
  duration: string,
  durationUnit: DurationUnit,
): string | null {
  const trimmedAmount = amount.trim();
  const trimmedDuration = duration.trim();
  if (!trimmedAmount || !trimmedDuration) return null; // other validators handle empty

  const parsedAmount = parseFloat(trimmedAmount);
  const parsedDuration = parseFloat(trimmedDuration);
  if (
    isNaN(parsedAmount) ||
    isNaN(parsedDuration) ||
    !Number.isFinite(parsedAmount) ||
    !Number.isFinite(parsedDuration) ||
    parsedAmount <= 0 ||
    parsedDuration <= 0
  ) {
    return null;
  }
  if (parsedAmount > Number(I128_MAX) / 10_000_000) {
    return "Amount exceeds the maximum supported value";
  }

  // Convert decimal token input without a floating-point round trip.
  const [whole = "0", fraction = ""] = trimmedAmount.split(".");
  if (!/^\d*(?:\.\d*)?$/.test(trimmedAmount) || fraction.length > 7) {
    return null; // amount validation reports malformed or over-precise input
  }
  const amountBase =
    BigInt(whole || "0") * 10_000_000n +
    BigInt((fraction + "0000000").slice(0, 7) || "0");
  const durationSeconds =
    BigInt(Math.round(parsedDuration)) * SECONDS_PER_UNIT[durationUnit];

  if (amountBase > I128_MAX) {
    return "Amount exceeds the maximum supported value";
  }
  if (durationSeconds > U64_MAX) {
    return "Duration exceeds the maximum supported value";
  }
  if (durationSeconds === 0n) {
    return "Duration must round to at least one second";
  }

  const rate = amountBase / durationSeconds;
  if (rate === 0n) {
    return "Stream rate is too small — the amount divided by duration rounds to zero. Increase the amount or shorten the duration.";
  }

  return null;
}

/**
 * Validate that the selected token is supported and has a contract address
 * configured for the current network.
 *
 * The Soroban contract rejects an invalid `token_address`; we predict this by
 * checking the token symbol against `TOKEN_ADDRESSES` (which is populated from
 * network-specific environment variables with testnet defaults).
 */
export function validateTokenForNetwork(
  token: string,
  walletNetwork?: string | null,
): string | null {
  if (!token || !token.trim()) {
    return "Please select a token";
  }
  const symbol = token.trim().toUpperCase();
  if (!(symbol in TOKEN_ADDRESSES)) {
    return "Unsupported token. Please select XLM, USDC, or EURC.";
  }
  if (walletNetwork && !isExpectedNetwork(walletNetwork)) {
    return "Wallet network does not match the network configured for this app.";
  }
  return null;
}

// ─── Composite validator ──────────────────────────────────────────────────────

/**
 * Validate stream form fields.
 *
 * In **step mode** (`options.step` is set) only the fields for the given wizard
 * step are checked.  In **flat mode** (no step) every field is validated.
 *
 * @returns An object of field→error entries.  Empty object = valid.
 */
export function validateStreamForm(
  data: StreamFormData,
  options: ValidationOptions = {},
): StreamFormErrors {
  const { step, walletBalance, walletNetwork } = options;
  const errors: StreamFormErrors = {};

  const shouldValidate = (
    fieldStep: number,
  ): boolean => (step === undefined || step === fieldStep);

  // Step 1 = Template selection — no field validation required
  // Step 2 = Recipient
  if (shouldValidate(2)) {
    const recipientError = validateRecipient(data.recipient);
    if (recipientError) errors.recipient = recipientError;
  }

  // Step 3 = Token
  if (shouldValidate(3)) {
    const tokenError = validateTokenForNetwork(data.token, walletNetwork);
    if (tokenError) errors.token = tokenError;
  }

  // Step 4 = Amount
  if (shouldValidate(4)) {
    const amountError = validateAmount(
      data.amount,
      walletBalance,
      data.token,
      getDefaultTokenDecimals(data.token),
    );
    if (amountError) errors.amount = amountError;

    // If the user has already entered a duration, surface rate errors early on
    // the amount step. When duration is still empty, step 5 catches it.
    if (data.duration.trim()) {
      const rateError = validateRate(
        data.amount,
        data.duration,
        data.durationUnit,
      );
      if (rateError) errors.rate = rateError;
    }
  }

  // Step 5 = Duration / Schedule
  if (shouldValidate(5)) {
    const durationError = validateDuration(data.duration);
    if (durationError) errors.duration = durationError;

    // Authoritative rate check — both amount and duration are known here.
    const rateError = validateRate(
      data.amount,
      data.duration,
      data.durationUnit,
    );
    if (rateError) errors.rate = rateError;
  }

  return errors;
}
