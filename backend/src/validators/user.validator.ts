import { z } from 'zod';

/**
 * Stellar Ed25519 account IDs are base32 strings: a `G` version byte prefix
 * followed by 55 characters from the RFC 4648 base32 alphabet, 56 in total.
 *
 * This is a format check only — it deliberately does not verify the trailing
 * CRC16 checksum, so callers must not treat a match as proof the key exists
 * or was typed correctly.
 */
export const STELLAR_PUBLIC_KEY_REGEX = /^G[A-Z2-7]{55}$/;

export const STELLAR_PUBLIC_KEY_ERROR =
    'Invalid Stellar public key format: expected 56 base32 characters starting with "G"';

/**
 * Reusable schema for a Stellar account public key.
 *
 * Rejects malformed keys at the validation layer so they never reach the
 * controller or repository, where they would surface as opaque lookup misses
 * or be stored as-is.
 */
export const stellarPublicKeySchema = z
    .string({ message: 'publicKey is required and must be a string' })
    .regex(STELLAR_PUBLIC_KEY_REGEX, STELLAR_PUBLIC_KEY_ERROR);

export const registerUserSchema = z.object({
    publicKey: stellarPublicKeySchema,
});

export type RegisterUserInput = z.infer<typeof registerUserSchema>;

/**
 * Path params for routes scoped to a single user, e.g. `GET /users/:publicKey`.
 *
 * Validating here means a malformed key is rejected with a 400 before the
 * controller runs, instead of surfacing as a 404 lookup miss or being echoed
 * back in an error response.
 */
export const userPublicKeyParamsSchema = z.object({
    publicKey: stellarPublicKeySchema,
});

export type UserPublicKeyParams = z.infer<typeof userPublicKeyParamsSchema>;

/**
 * Default and maximum page sizes for the events listing. Kept as named
 * constants so the schema, controller, and docs cannot drift apart.
 */
export const EVENTS_DEFAULT_LIMIT = 20;
export const EVENTS_MAX_LIMIT = 100;

/**
 * Query schema for `GET /users/:publicKey/events`.
 *
 * - `limit` / `offset` arrive as strings from the query string and are
 *   coerced to non-negative integers. `limit` is capped at
 *   {@link EVENTS_MAX_LIMIT}; `offset` is unbounded.
 * - `eventType` is an optional free-form filter string; empty strings are
 *   treated as "no filter" so `?eventType=` behaves like an omitted param.
 *
 * Unknown query keys are stripped rather than rejected, preserving the
 * previous lenient behavior for clients that send cache-busting params.
 */
export const userEventsQuerySchema = z.object({
    limit: z.coerce
        .number({ message: 'limit must be a number' })
        .int('limit must be an integer')
        .min(1, 'limit must be at least 1')
        .max(EVENTS_MAX_LIMIT, `limit must be at most ${EVENTS_MAX_LIMIT}`)
        .default(EVENTS_DEFAULT_LIMIT),
    offset: z.coerce
        .number({ message: 'offset must be a number' })
        .int('offset must be an integer')
        .min(0, 'offset must be at least 0')
        .default(0),
    eventType: z
        .string({ message: 'eventType must be a string' })
        .trim()
        .min(1, 'eventType must not be empty')
        .optional(),
});

export type UserEventsQuery = z.infer<typeof userEventsQuerySchema>;