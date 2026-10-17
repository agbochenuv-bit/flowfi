import type { Request, Response, NextFunction } from 'express';
import { Prisma } from '../generated/prisma/index.js';
import { ZodError, type ZodIssue } from 'zod';
import logger from '../logger.js';
import { ApiError, sendApiError } from '../types/api-error.js';
import { ERROR_CODES } from '../types/error-codes.js';

/**
 * Resolve the request correlation id attached by the request-id middleware.
 * Falls back to the `x-request-id` header so the envelope always carries an id.
 */
const resolveRequestId = (req: Request): string | undefined => {
    const fromReq = (req as Request & { requestId?: string }).requestId;
    if (typeof fromReq === 'string' && fromReq.length > 0) {
        return fromReq;
    }
    const header = req.headers?.['x-request-id'];
    if (typeof header === 'string' && header.length > 0) {
        return header;
    }
    if (Array.isArray(header) && header.length > 0) {
        return header[0];
    }
    return undefined;
};

/**
 * Normalize Zod issues into safe validation details: field path + message only.
 * Never includes stack traces or internal exception text.
 */
const normalizeValidationDetails = (issues: ZodIssue[]) =>
    issues.map((e: ZodIssue) => ({
        path: e.path.join('.'),
        message: e.message,
        code: e.code,
    }));

/**
 * Global error handler middleware
 */
export const errorHandler = (
    err: unknown,
    req: Request,
    res: Response,
    next: NextFunction
) => {
    logger.error('Unhandled error:', err);

    if (res.headersSent) {
        return next(err);
    }

    const requestId = resolveRequestId(req);

    // body-parser signals an over-limit body with `type: 'entity.too.large'`
    // (and status 413). Translate it to the API's standard JSON error envelope
    // instead of leaking the raw parser message.
    const maybeStatus = (err as { status?: number; statusCode?: number })?.status
        ?? (err as { statusCode?: number })?.statusCode;
    if ((err as { type?: string })?.type === 'entity.too.large' || maybeStatus === 413) {
        return sendApiError(
            res,
            413,
            ERROR_CODES.PAYLOAD_TOO_LARGE,
            'Request payload exceeds the allowed size limit.',
            undefined,
            requestId,
        );
    }

    if (err instanceof ZodError) {
        return sendApiError(
            res,
            400,
            ERROR_CODES.VALIDATION_FAILED,
            'Request validation failed',
            normalizeValidationDetails(err.issues),
            requestId,
        );
    }

    if (err instanceof ApiError) {
        return sendApiError(res, err.statusCode, err.code, err.message, err.details, requestId);
    }

    // Handle Prisma Errors
    if (err instanceof Prisma.PrismaClientKnownRequestError) {
        // Unique constraint violation
        if ((err as Prisma.PrismaClientKnownRequestError).code === 'P2002') {
            const target = ((err as Prisma.PrismaClientKnownRequestError).meta?.target as string[])?.join(', ') || 'field';
            return sendApiError(
                res,
                409,
                ERROR_CODES.CONFLICT,
                `Record with this ${target} already exists.`,
                undefined,
                requestId,
            );
        }

        // Record not found
        if ((err as Prisma.PrismaClientKnownRequestError).code === 'P2025') {
            return sendApiError(
                res,
                404,
                ERROR_CODES.NOT_FOUND,
                'The requested record was not found.',
                undefined,
                requestId,
            );
        }
    }

    // Default Error: never expose internal exception text or stack traces.
    const statusCode = (err instanceof Error && (err as any).status) || (err instanceof Error && (err as any).statusCode) || 500;
    if (statusCode >= 500) {
        return sendApiError(
            res,
            500,
            ERROR_CODES.INTERNAL_ERROR,
            'A technical error occurred. Please try again later.',
            undefined,
            requestId,
        );
    }
    return sendApiError(
        res,
        statusCode,
        ERROR_CODES.REQUEST_ERROR,
        'Request failed',
        undefined,
        requestId,
    );
};
