import { PrismaClient, PaymentPolicy, PolicyEvaluation } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { logger } from '../lib/logger';

/**
 * Payment Policy Evaluation Service
 * =================================
 *
 * This service provides a *server-side policy boundary* that allows customers to
 * define business rules which are checked BEFORE a transaction is prepared.
 *
 * IMPORTANT: A policy `allow` decision is NOT on-chain authorization. It does not
 * grant the wallet permission to move funds, it does not bypass wallet signature
 * verification, and it does not replace chain/network validation. It is purely a
 * business-rule gate that runs in addition to (never instead of) the cryptographic
 * and financial-invariant checks performed elsewhere in the transaction pipeline.
 *
 * Determinism
 * -----------
 * Rules are evaluated in a fixed, documented order against a normalized input
 * snapshot. Given the same policy and the same input, the result is deterministic
 * (modulo the `latencyMs` timing field). No rule depends on wall-clock time,
 * randomness, or external network calls.
 *
 * Timeout & failure behavior
 * --------------------------
 * Evaluation is bounded by a configurable timeout (default 2000ms). If evaluation
 * exceeds the timeout, or if any unexpected error occurs, the outcome is governed
 * by the policy's `failOpen` flag:
 *   - failOpen = false (default): decision = 'error'  -> treated as DENY (fail-closed)
 *   - failOpen = true:            decision = 'error'  -> treated as ALLOW (fail-open)
 * The `decision` field is always one of 'allow' | 'deny' | 'error'. Callers that
 * need a strict boolean should use `assertPolicyAllows`, which maps 'error' to a
 * deny unless the policy is fail-open.
 *
 * Audit
 * -----
 * Every evaluation (allow, deny, or error) persists a `PolicyEvaluation` row with
 * the fields: policyId, actor, wallet, amount, token, recipient, network,
 * decision, reason, latencyMs. Audit persistence failures are logged but never
 * change the decision returned to the caller.
 */

/** Default evaluation timeout in milliseconds. */
export const DEFAULT_POLICY_TIMEOUT_MS = 2000;

/** The structured decision returned by an evaluation. */
export type PolicyDecision = 'allow' | 'deny' | 'error';

/** Normalized input snapshot passed to the policy evaluator. */
export interface PaymentPolicyInput {
  /** The acting user / API key identity (for audit). */
  actor: string;
  /** The wallet address initiating the transaction. */
  wallet: string;
  /** The amount to be transferred, as a decimal string (e.g. "12.5"). */
  amount: string;
  /** The token symbol / identifier (e.g. "USDC"). */
  token: string;
  /** The recipient address. */
  recipient: string;
  /** The chain / network identifier (e.g. "ethereum-mainnet"). */
  network: string;
  /** Optional override for the evaluation timeout in milliseconds. */
  timeoutMs?: number;
}

/** The structured result of a policy evaluation. */
export interface PaymentPolicyResult {
  decision: PolicyDecision;
  reason: string;
  policyId: string | null;
  latencyMs: number;
}

/** Typed error thrown by `assertPolicyAllows` so controllers can map to HTTP codes. */
export class PaymentPolicyError extends Error {
  public readonly code: 'POLICY_DENIED' | 'POLICY_ERROR';
  public readonly policyId: string | null;
  public readonly reason: string;
  public readonly latencyMs: number;

  constructor(result: PaymentPolicyResult) {
    super(result.reason);
    this.name = 'PaymentPolicyError';
    this.code = result.decision === 'deny' ? 'POLICY_DENIED' : 'POLICY_ERROR';
    this.policyId = result.policyId;
    this.reason = result.reason;
    this.latencyMs = result.latencyMs;
  }
}

/**
 * A single deterministic rule. Returns `null` when the rule passes, or a
 * human-readable reason string when the rule denies the transaction.
 */
type PolicyRule = (input: PaymentPolicyInput, policy: PaymentPolicy) => string | null;

/**
 * The ordered set of deterministic rules. Order matters for the `reason` reported
 * on the first failing rule. All comparisons are pure functions of the input.
 */
const RULES: PolicyRule[] = [
  // Network allow-list: if the policy restricts networks, the input must match.
  (input, policy) => {
    const allowed = parseStringList((policy as any).allowedNetworks);
    if (allowed.length > 0 && !allowed.includes(input.network)) {
      return `network '${input.network}' is not permitted by policy`;
    }
    return null;
  },
  // Token allow-list.
  (input, policy) => {
    const allowed = parseStringList((policy as any).allowedTokens);
    if (allowed.length > 0 && !allowed.includes(input.token)) {
      return `token '${input.token}' is not permitted by policy`;
    }
    return null;
  },
  // Recipient allow-list.
  (input, policy) => {
    const allowed = parseStringList((policy as any).allowedRecipients);
    if (allowed.length > 0 && !allowed.includes(input.recipient)) {
      return `recipient '${input.recipient}' is not permitted by policy`;
    }
    return null;
  },
  // Per-transaction maximum amount.
  (input, policy) => {
    const max = (policy as any).maxAmountPerTx;
    if (max !== null && max !== undefined && max !== '') {
      const maxNum = Number(max);
      const amtNum = Number(input.amount);
      if (!Number.isFinite(amtNum)) {
        return `amount '${input.amount}' is not a valid number`;
      }
      if (Number.isFinite(maxNum) && amtNum > maxNum) {
        return `amount ${input.amount} exceeds per-transaction maximum ${max}`;
      }
    }
    return null;
  },
  // Minimum amount (guards against dust / zero-value transfers).
  (input, policy) => {
    const min = (policy as any).minAmountPerTx;
    if (min !== null && min !== undefined && min !== '') {
      const minNum = Number(min);
      const amtNum = Number(input.amount);
      if (!Number.isFinite(amtNum)) {
        return `amount '${input.amount}' is not a valid number`;
      }
      if (Number.isFinite(minNum) && amtNum < minNum) {
        return `amount ${input.amount} is below minimum ${min}`;
      }
    }
    return null;
  },
];

/** Parse a JSON-encoded or comma-separated string list into a trimmed array. */
function parseStringList(value: unknown): string[] {
  if (value === null || value === undefined) return [];
  if (Array.isArray(value)) return value.map((v) => String(v).trim()).filter(Boolean);
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return [];
    if (trimmed.startsWith('[')) {
      try {
        const parsed = JSON.parse(trimmed);
        if (Array.isArray(parsed)) {
          return parsed.map((v) => String(v).trim()).filter(Boolean);
        }
      } catch {
        // fall through to comma-split
      }
    }
    return trimmed.split(',').map((v) => v.trim()).filter(Boolean);
  }
  return [];
}

/** Run all rules synchronously; returns the first denial reason or null. */
function runRules(input: PaymentPolicyInput, policy: PaymentPolicy): string | null {
  for (const rule of RULES) {
    const reason = rule(input, policy);
    if (reason) return reason;
  }
  return null;
}

/** Load the user's enabled policy (most recently updated wins). */
async function loadEnabledPolicy(actor: string): Promise<PaymentPolicy | null> {
  return prisma.paymentPolicy.findFirst({
    where: { ownerId: actor, enabled: true },
    orderBy: { updatedAt: 'desc' },
  });
}

/** Persist an audit row. Never throws; logs on failure. */
async function persistAudit(
  input: PaymentPolicyInput,
  result: PaymentPolicyResult,
): Promise<void> {
  try {
    await prisma.policyEvaluation.create({
      data: {
        policyId: result.policyId,
        actor: input.actor,
        wallet: input.wallet,
        amount: input.amount,
        token: input.token,
        recipient: input.recipient,
        network: input.network,
        decision: result.decision,
        reason: result.reason,
        latencyMs: result.latencyMs,
      },
    });
  } catch (err) {
    logger.error('Failed to persist PolicyEvaluation audit row', {
      error: err instanceof Error ? err.message : String(err),
      actor: input.actor,
      policyId: result.policyId,
      decision: result.decision,
    });
  }
}

/** Wrap a promise with a timeout that rejects with a sentinel error. */
function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`policy evaluation timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    // Do not keep the event loop alive solely for the timer.
    if (typeof timer.unref === 'function') timer.unref();
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

/**
 * Evaluate the user's enabled payment policy against the validated input.
 *
 * Returns a structured result. This function never throws for policy denials or
 * evaluation errors; it encodes the outcome in the `decision` field. Audit rows
 * are persisted for every evaluation.
 *
 * NOTE: An 'allow' decision is a business-rule pass only. It is NOT on-chain
 * authorization and must not be used to skip wallet signature verification,
 * chain/network validation, or financial accounting checks.
 */
export async function evaluatePaymentPolicy(
  input: PaymentPolicyInput,
): Promise<PaymentPolicyResult> {
  const startedAt = Date.now();
  const timeoutMs =
    typeof input.timeoutMs === 'number' && input.timeoutMs > 0
      ? input.timeoutMs
      : DEFAULT_POLICY_TIMEOUT_MS;

  let policy: PaymentPolicy | null = null;
  let result: PaymentPolicyResult;

  try {
    policy = await withTimeout(loadEnabledPolicy(input.actor), timeoutMs);

    if (!policy) {
      // No enabled policy => nothing to enforce => allow.
      result = {
        decision: 'allow',
        reason: 'no enabled payment policy',
        policyId: null,
        latencyMs: Date.now() - startedAt,
      };
    } else {
      const denialReason = await withTimeout(
        Promise.resolve(runRules(input, policy)),
        timeoutMs,
      );
      result = denialReason
        ? {
            decision: 'deny',
            reason: denialReason,
            policyId: policy.id,
            latencyMs: Date.now() - startedAt,
          }
        : {
            decision: 'allow',
            reason: 'all policy rules passed',
            policyId: policy.id,
            latencyMs: Date.now() - startedAt,
          };
    }
  } catch (err) {
    const failOpen = Boolean(policy && (policy as any).failOpen === true);
    const message = err instanceof Error ? err.message : String(err);
    result = {
      decision: 'error',
      reason: failOpen
        ? `policy evaluation failed (fail-open): ${message}`
        : `policy evaluation failed (fail-closed): ${message}`,
      policyId: policy ? policy.id : null,
      latencyMs: Date.now() - startedAt,
    };
  }

  await persistAudit(input, result);
  return result;
}

/**
 * Assert that the policy allows the transaction. Throws a `PaymentPolicyError`
 * when the decision is 'deny', or when the decision is 'error' and the policy is
 * NOT fail-open. Controllers can map:
 *   - code 'POLICY_DENIED' -> HTTP 403
 *   - code 'POLICY_ERROR'  -> HTTP 422
 *
 * Returns the result on success so callers can log the policyId/latency.
 */
export async function assertPolicyAllows(
  input: PaymentPolicyInput,
): Promise<PaymentPolicyResult> {
  const result = await evaluatePaymentPolicy(input);

  if (result.decision === 'allow') {
    return result;
  }

  if (result.decision === 'error') {
    // Fail-open policies let errors through; fail-closed policies reject.
    const failOpen = await isFailOpen(result.policyId);
    if (failOpen) {
      return result;
    }
  }

  throw new PaymentPolicyError(result);
}

/** Look up whether a policy is fail-open (used only for error decisions). */
async function isFailOpen(policyId: string | null): Promise<boolean> {
  if (!policyId) return false;
  try {
    const policy = await prisma.paymentPolicy.findUnique({ where: { id: policyId } });
    return Boolean(policy && (policy as any).failOpen === true);
  } catch {
    return false;
  }
}

export type { PaymentPolicy, PolicyEvaluation };