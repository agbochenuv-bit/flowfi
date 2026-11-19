import { z } from 'zod';
import { parseStreamId } from '../lib/stream-id.js';

const MAX_I128 = BigInt('170141183460469231731687303715884105727');

export const createStreamSchema = z.object({
  streamId: z
    .union([z.number(), z.string(), z.bigint()])
    .transform((v, ctx) => {
      const parsed = parseStreamId(v);
      if (parsed === null) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'streamId must be a non-negative integer',
        });
        return z.NEVER;
      }
      return parsed;
    }),
  sender: z.string().min(1, 'Sender address is required'),
  recipient: z.string().min(1, 'Recipient address is required'),
  tokenAddress: z.string().min(1, 'Token address is required'),
  ratePerSecond: z
    .string()
    .regex(/^\d+$/, 'Rate must be a positive integer as string')
    .refine(
      (val) => {
        try {
          return BigInt(val) <= MAX_I128;
        } catch {
          return true;
        }
      },
      { message: 'Rate exceeds maximum allowed value' },
    ),
  depositedAmount: z.string().regex(/^\d+$/, 'Amount must be a positive integer as string'),
  startTime: z.union([z.number().int().nonnegative(), z.string().regex(/^\d+$/).transform(v => parseInt(v))]),
  /**
   * Optional customer-defined payment policy identifier. When provided, the
   * server evaluates the referenced policy before preparing the transaction.
   * Backward compatible: omitting it skips policy evaluation.
   */
  policyId: z.string().min(1, 'policyId must be a non-empty string').optional(),
});

export type CreateStreamInput = z.infer<typeof createStreamSchema>;

/**
 * Schema for a single stream identifier, used in path parameters.
 * Accepts a non-negative integer (as number or numeric string) and
 * normalizes it to a bigint via `parseStreamId`.
 */
export const streamIdParamSchema = z.object({
  streamId: z
    .union([z.number(), z.string(), z.bigint()])
    .transform((v, ctx) => {
      const parsed = parseStreamId(v);
      if (parsed === null) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'streamId must be a non-negative integer',
        });
        return z.NEVER;
      }
      return parsed;
    }),
});

export type StreamIdParamInput = z.infer<typeof streamIdParamSchema>;

const DEFAULT_PAGE = 1;
const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 100;

const paginationFields = {
  page: z
    .union([z.number(), z.string()])
    .optional()
    .transform((v, ctx) => {
      if (v === undefined || v === '') return DEFAULT_PAGE;
      const n = typeof v === 'number' ? v : Number(v);
      if (!Number.isInteger(n) || n < 1) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'page must be a positive integer',
        });
        return z.NEVER;
      }
      return n;
    }),
  pageSize: z
    .union([z.number(), z.string()])
    .optional()
    .transform((v, ctx) => {
      if (v === undefined || v === '') return DEFAULT_PAGE_SIZE;
      const n = typeof v === 'number' ? v : Number(v);
      if (!Number.isInteger(n) || n < 1 || n > MAX_PAGE_SIZE) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `pageSize must be an integer between 1 and ${MAX_PAGE_SIZE}`,
        });
        return z.NEVER;
      }
      return n;
    }),
};

/**
 * Schema for list-streams query parameters: pagination plus optional filters.
 */
export const listStreamsQuerySchema = z.object({
  ...paginationFields,
  sender: z.string().min(1, 'Sender address is required').optional(),
  recipient: z.string().min(1, 'Recipient address is required').optional(),
  tokenAddress: z.string().min(1, 'Token address is required').optional(),
  status: z
    .enum(['active', 'completed', 'cancelled', 'paused'])
    .optional(),
});

export type ListStreamsQueryInput = z.infer<typeof listStreamsQuerySchema>;

/**
 * Schema for stream history/events query parameters: pagination plus an
 * optional event type filter.
 */
export const streamHistoryQuerySchema = z.object({
  ...paginationFields,
  eventType: z
    .enum(['created', 'withdrawn', 'cancelled', 'paused', 'resumed', 'completed'])
    .optional(),
});

export type StreamHistoryQueryInput = z.infer<typeof streamHistoryQuerySchema>;

/**
 * Schema for a payment policy evaluation request.
 *
 * This is a server-side business-rule boundary checked before a transaction
 * is prepared. A successful evaluation is NOT on-chain authorization; wallet
 * authorization and chain/network validation remain authoritative.
 *
 * Inputs:
 * - actorWallet: the wallet performing the action (authorization subject).
 * - walletAddress: the wallet address the transaction will be prepared for.
 * - amount: the transaction amount as a positive integer string (base units).
 * - tokenAddress: the token contract address involved.
 * - recipient: the recipient address of the transaction.
 * - network: the target chain/network identifier.
 * - policyId: optional identifier of the customer-defined policy to evaluate.
 */
export const paymentPolicyEvaluationSchema = z.object({
  actorWallet: z.string().min(1, 'actorWallet is required'),
  walletAddress: z.string().min(1, 'walletAddress is required'),
  amount: z
    .string()
    .regex(/^\d+$/, 'amount must be a positive integer as string')
    .refine(
      (val) => {
        try {
          return BigInt(val) <= MAX_I128;
        } catch {
          return true;
        }
      },
      { message: 'amount exceeds maximum allowed value' },
    ),
  tokenAddress: z.string().min(1, 'tokenAddress is required'),
  recipient: z.string().min(1, 'recipient is required'),
  network: z.string().min(1, 'network is required'),
  policyId: z.string().min(1, 'policyId must be a non-empty string').optional(),
});

export type PaymentPolicyEvaluationInput = z.infer<typeof paymentPolicyEvaluationSchema>;