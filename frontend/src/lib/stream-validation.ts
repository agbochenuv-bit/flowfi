/**
 * Stream validation helpers.
 *
 * This module contains pure, framework-agnostic validation utilities used by
 * the stream creation flow. It covers single-recipient validation as well as
 * multi-recipient (weighted) stream configuration, including exact
 * per-recipient amount computation that mirrors the on-chain contract rules.
 */

/** Maximum number of recipients allowed in a single multi-recipient stream. */
export const MAX_RECIPIENTS = 100;

/** Minimum total weight allowed by the contract. */
export const MIN_TOTAL_WEIGHT = 1;

/** Maximum total weight allowed by the contract (uint32 range). */
export const MAX_TOTAL_WEIGHT = 4_294_967_295;

/** Maximum weight allowed for a single recipient (uint32 range). */
export const MAX_RECIPIENT_WEIGHT = 4_294_967_295;

/** A recipient with an associated weight for a multi-recipient stream. */
export interface WeightedRecipient {
  /** Stellar account address (G...). */
  address: string;
  /** Positive integer weight determining the recipient's share. */
  weight: number;
}

/** Result of computing exact per-recipient amounts. */
export interface WeightedAmountResult {
  /** Per-recipient raw amounts (in the token's smallest unit), aligned by index. */
  amounts: bigint[];
  /** Sum of all amounts; always equals the requested total. */
  total: bigint;
}

/** Result of a validation check. */
export interface ValidationResult {
  valid: boolean;
  errors: string[];
}

const STELLAR_ADDRESS_REGEX = /^G[A-Z2-7]{55}$/;

/**
 * Validates a single Stellar recipient address.
 *
 * @param address - The address to validate.
 * @returns `true` when the address is a well-formed Stellar public key.
 */
export function validateRecipient(address: string): boolean {
  if (typeof address !== 'string') {
    return false;
  }
  return STELLAR_ADDRESS_REGEX.test(address.trim());
}

/**
 * Validates a list of weighted recipients.
 *
 * Checks that:
 * - at least one recipient is provided;
 * - the recipient count does not exceed {@link MAX_RECIPIENTS};
 * - every address is a valid Stellar address;
 * - no duplicate addresses are present.
 *
 * @param recipients - The recipients to validate.
 * @returns A {@link ValidationResult} describing validity and any errors.
 */
export function validateRecipients(recipients: WeightedRecipient[]): ValidationResult {
  const errors: string[] = [];

  if (!Array.isArray(recipients) || recipients.length === 0) {
    errors.push('At least one recipient is required.');
    return { valid: false, errors };
  }

  if (recipients.length > MAX_RECIPIENTS) {
    errors.push(`A stream may have at most ${MAX_RECIPIENTS} recipients.`);
  }

  const seen = new Set<string>();

  recipients.forEach((recipient, index) => {
    const address = typeof recipient?.address === 'string' ? recipient.address.trim() : '';

    if (!validateRecipient(address)) {
      errors.push(`Recipient ${index + 1} has an invalid address.`);
      return;
    }

    if (seen.has(address)) {
      errors.push(`Recipient ${index + 1} duplicates another recipient address.`);
      return;
    }

    seen.add(address);
  });

  return { valid: errors.length === 0, errors };
}

/**
 * Validates the weights of a list of weighted recipients.
 *
 * Checks that:
 * - every weight is a positive integer;
 * - no single weight exceeds {@link MAX_RECIPIENT_WEIGHT};
 * - the total weight is within [{@link MIN_TOTAL_WEIGHT}, {@link MAX_TOTAL_WEIGHT}].
 *
 * @param recipients - The recipients whose weights should be validated.
 * @returns A {@link ValidationResult} describing validity and any errors.
 */
export function validateWeights(recipients: WeightedRecipient[]): ValidationResult {
  const errors: string[] = [];

  if (!Array.isArray(recipients) || recipients.length === 0) {
    errors.push('At least one recipient is required to validate weights.');
    return { valid: false, errors };
  }

  let total = 0;

  recipients.forEach((recipient, index) => {
    const weight = recipient?.weight;

    if (typeof weight !== 'number' || !Number.isFinite(weight) || !Number.isInteger(weight)) {
      errors.push(`Recipient ${index + 1} weight must be a positive integer.`);
      return;
    }

    if (weight <= 0) {
      errors.push(`Recipient ${index + 1} weight must be greater than zero.`);
      return;
    }

    if (weight > MAX_RECIPIENT_WEIGHT) {
      errors.push(`Recipient ${index + 1} weight exceeds the maximum allowed weight.`);
      return;
    }

    total += weight;
  });

  if (errors.length === 0) {
    if (total < MIN_TOTAL_WEIGHT) {
      errors.push(`Total weight must be at least ${MIN_TOTAL_WEIGHT}.`);
    } else if (total > MAX_TOTAL_WEIGHT) {
      errors.push(`Total weight must not exceed ${MAX_TOTAL_WEIGHT}.`);
    }
  }

  return { valid: errors.length === 0, errors };
}

/**
 * Computes exact per-recipient raw amounts for a weighted stream.
 *
 * Uses the largest-remainder method so that the sum of the returned amounts
 * always equals `totalRaw` exactly, matching the contract's accounting
 * invariants. Amounts are returned as `bigint` values in the token's smallest
 * unit, aligned by recipient index.
 *
 * @param totalRaw - Total raw amount to distribute (in smallest unit).
 * @param recipients - Weighted recipients.
 * @param decimals - Token decimals (used for documentation/rounding context).
 * @returns The per-recipient amounts and their exact total.
 * @throws {Error} When inputs are invalid or the total cannot be distributed.
 */
export function computeWeightedAmounts(
  totalRaw: bigint | number | string,
  recipients: WeightedRecipient[],
  decimals: number,
): WeightedAmountResult {
  if (!Array.isArray(recipients) || recipients.length === 0) {
    throw new Error('At least one recipient is required to compute amounts.');
  }

  if (typeof decimals !== 'number' || !Number.isInteger(decimals) || decimals < 0) {
    throw new Error('Decimals must be a non-negative integer.');
  }

  let total: bigint;
  try {
    total = BigInt(totalRaw);
  } catch {
    throw new Error('Total amount must be a valid integer.');
  }

  if (total < 0n) {
    throw new Error('Total amount must not be negative.');
  }

  const weights: bigint[] = [];
  let weightSum = 0n;

  recipients.forEach((recipient, index) => {
    const weight = recipient?.weight;
    if (typeof weight !== 'number' || !Number.isInteger(weight) || weight <= 0) {
      throw new Error(`Recipient ${index + 1} weight must be a positive integer.`);
    }
    const w = BigInt(weight);
    weights.push(w);
    weightSum += w;
  });

  if (weightSum <= 0n) {
    throw new Error('Total weight must be greater than zero.');
  }

  const amounts: bigint[] = [];
  const remainders: { index: number; remainder: bigint }[] = [];
  let distributed = 0n;

  for (let i = 0; i < weights.length; i += 1) {
    const numerator = total * weights[i];
    const base = numerator / weightSum;
    const remainder = numerator % weightSum;
    amounts.push(base);
    distributed += base;
    remainders.push({ index: i, remainder });
  }

  // Distribute the leftover units using the largest-remainder method.
  let leftover = total - distributed;

  if (leftover > 0n) {
    remainders.sort((a, b) => {
      if (a.remainder === b.remainder) {
        return a.index - b.index;
      }
      return a.remainder > b.remainder ? -1 : 1;
    });

    let cursor = 0;
    while (leftover > 0n) {
      const target = remainders[cursor % remainders.length];
      amounts[target.index] += 1n;
      leftover -= 1n;
      cursor += 1;
    }
  }

  const sum = amounts.reduce((acc, amount) => acc + amount, 0n);
  if (sum !== total) {
    throw new Error('Internal error: distributed amounts do not sum to the total.');
  }

  return { amounts, total: sum };
}