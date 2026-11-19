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

/**
 * Shared schema for the optimistic-concurrency `expectedVersion` field.
 *
 * Clients may submit the stream state version they reviewed when preparing a
 * mutation. The value is optional for backwards compatibility: when omitted,
 * the mutation proceeds without a version check. When provided, it must be a
 * non-negative integer (as a number or numeric string) and is normalized to a
 * `number`.
 */
export const expectedVersionSchema = z
  .union([z.number(), z.string()])
  .optional()
  .transform((v, ctx) => {
    if (v === undefined || v === '') return undefined;
    const n = typeof v === 'number' ? v : Number(v);
    if (!Number.isInteger(n) || n < 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'expectedVersion must be a non-negative integer',
      });
      return z.NEVER;
    }
    return n;
  });

export type ExpectedVersionInput = z.infer<typeof expectedVersionSchema>;

/**
 * Schema for stream mutation requests (cancel, withdraw, top-up, pause, resume).
 * All mutations accept an optional `expectedVersion` for optimistic concurrency.
 */
export const streamMutationSchema = z.object({
  expectedVersion: expectedVersionSchema,
});

export type StreamMutationInput = z.infer<typeof streamMutationSchema>;

/**
 * Schema for cancel-stream requests.
 */
export const cancelStreamSchema = streamMutationSchema;
export type CancelStreamInput = z.infer<typeof cancelStreamSchema>;

/**
 * Schema for withdraw requests.
 */
export const withdrawStreamSchema = streamMutationSchema;
export type WithdrawStreamInput = z.infer<typeof withdrawStreamSchema>;

/**
 * Schema for top-up requests.
 */
export const topUpStreamSchema = streamMutationSchema;
export type TopUpStreamInput = z.infer<typeof topUpStreamSchema>;

/**
 * Schema for pause requests.
 */
export const pauseStreamSchema = streamMutationSchema;
export type PauseStreamInput = z.infer<typeof pauseStreamSchema>;

/**
 * Schema for resume requests.
 */
export const resumeStreamSchema = streamMutationSchema;
export type ResumeStreamInput = z.infer<typeof resumeStreamSchema>;

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