import type { Request, Response, NextFunction } from 'express';
import { Prisma } from '../generated/prisma/index.js';
import { ZodError, type ZodIssue } from 'zod';
import logger from '../logger.js';
import { ApiError, sendApiError } from '../types/api-error.js';

const GENERIC_5XX_MESSAGE = 'A technical error occurred. Please try again later.';

/**
 * Resolve an HTTP status from an arbitrary thrown value without trusting it
 * blindly. Only integer statuses in the 4xx/5xx range are honoured.
 */
const resolveStatus = (err: unknown): number | undefined => {
    const candidate =
        (err as { status?: unknown })?.status ??
        (err as { statusCode?: unknown })?.statusCode;

    if (typeof candidate === 'number' && Number.isInteger(candidate) && candidate >= 400 && candidate <= 599) {
        return candidate;
    }

    return undefined;
};

/**
 * Global error handler middleware.
 *
 * Centralizes mapping of every thrown value to the standard API error
 * envelope `{ error: { code, message, details? } }`. Internal details
 * (stack traces, Prisma meta, raw driver messages) are never exposed to
 * clients; the original error is always logged server-side.
 */
export const errorHandler = (
    err: unknown,
    req: Request,
    res: Response,
    next: NextFunction
) => {
    // Always log the original error server-side before any sanitization.
    logger.error('Unhandled error:', err);

    // Express 5: if the response has already started, delegate to the
    // default handler so the connection is closed correctly.
    if (res.headersSent) {
        return next(err);
    }

    // body-parser signals an over-limit body with `type: 'entity.too.large'`
    // (and status 413). Translate it to the API's standard JSON error envelope
    // instead of leaking the raw parser message.
    if ((err as { type?: string })?.type === 'entity.too.large' || resolveStatus(err) === 413) {
        return sendApiError(
            res,
            413,
            'PAYLOAD_TOO_LARGE',
            'Request payload exceeds the allowed size limit.',
        );
    }

    // Zod validation errors -> 400 with per-field details.
    if (err instanceof ZodError) {
        return sendApiError(
            res,
            400,
            'VALIDATION_ERROR',
            'Request validation failed',
            err.issues.map((e: ZodIssue) => ({
                path: e.path.join('.'),
                message: e.message,
                code: e.code,
            })),
        );
    }

    // Unified domain error.
    if (err instanceof ApiError) {
        const statusCode = err.statusCode >= 500 ? 500 : err.statusCode;
        const code = statusCode >= 500 ? 'INTERNAL_SERVER_ERROR' : err.code;
        const message = statusCode >= 500 ? GENERIC_5XX_MESSAGE : err.message;
        const details = statusCode >= 500 ? undefined : err.details;
        return sendApiError(res, statusCode, code, message, details);
    }

    // Prisma known request errors -> stable, non-leaking mappings.
    if (err instanceof Prisma.PrismaClientKnownRequestError) {
        // Unique constraint violation
        if (err.code === 'P2002') {
            const target = (err.meta?.target as string[] | string | undefined);
            const fields = Array.isArray(target) ? target.join(', ') : target;
            return sendApiError(
                res,
                409,
                'CONFLICT',
                fields ? `Record with this ${fields} already exists.` : 'Record already exists.',
            );
        }

        // Record not found
        if (err.code === 'P2025') {
            return sendApiError(res, 404, 'NOT_FOUND', 'The requested record was not found.');
        }

        // Foreign key constraint violation
        if (err.code === 'P2003') {
            return sendApiError(res, 409, 'CONFLICT', 'The request conflicts with a related record.');
        }
    }

    // Unknown / unexpected errors: never leak stack traces or internal
    // identifiers. 4xx statuses keep their (already client-safe) message;
    // everything else collapses to a generic 500.
    const statusCode = resolveStatus(err) ?? 500;
    if (statusCode >= 500) {
        return sendApiError(res, 500, 'INTERNAL_SERVER_ERROR', GENERIC_5XX_MESSAGE);
    }

    const message = err instanceof Error && err.message ? err.message : 'Request failed';
    return sendApiError(res, statusCode, 'REQUEST_ERROR', message);
};
