import type { NextFunction, Request, Response } from "express";
import { z } from "zod";
import { ApiError, ErrorCode } from "../errors/api-error";

/**
 * Zod-backed request validation that mirrors the OpenAPI contract.
 *
 * Attach per route: `router.post("/x", validateRequest({ body: schema }), handler)`.
 * Invalid requests never reach the controller; they get a single RFC 7807
 * Problem Details response. Parsed (coerced) values are exposed on
 * `res.locals.validated` so controllers stop re-parsing input.
 */

export const INVALID_PARAMETERS_TYPE = "https://flowfi.org/errors/invalid-parameters";

export interface InvalidParam {
  name: string;
  reason: string;
}

export interface ProblemDetails {
  type: string;
  title: string;
  status: number;
  detail: string;
  invalidParams: InvalidParam[];
}

export interface RequestSchemas {
  params?: z.ZodType;
  query?: z.ZodType;
  body?: z.ZodType;
  headers?: z.ZodType;
}

export type ValidatedRequest = Partial<Record<keyof RequestSchemas, unknown>>;

const SOURCES: (keyof RequestSchemas)[] = ["headers", "params", "query", "body"];

function toInvalidParams(error: z.ZodError): InvalidParam[] {
  return error.issues.map((issue) => ({
    name: issue.path.length ? issue.path.join(".") : "(root)",
    reason: issue.message,
  }));
}

/**
 * Maps a Zod error onto the stable, machine-readable validation detail shape.
 * Only the field path and a safe message are surfaced; no validator internals
 * (issue codes, expected types, stack frames) leak to clients.
 */
function toValidationDetails(error: z.ZodError): { path: string; message: string }[] {
  return error.issues.map((issue) => ({
    path: issue.path.length ? issue.path.join(".") : "(root)",
    message: issue.message,
  }));
}

export function invalidParametersProblem(invalidParams: InvalidParam[]): ProblemDetails {
  const first = invalidParams[0];
  return {
    type: INVALID_PARAMETERS_TYPE,
    title: "Invalid Request Parameters",
    status: 400,
    detail: first ? `Invalid parameter '${first.name}': ${first.reason}` : "Invalid request",
    invalidParams,
  };
}

/**
 * Builds the stable validation error envelope directly. Exposed so callers
 * that validate outside the middleware (e.g. background jobs) can reuse the
 * exact same code and detail shape.
 */
export function validationFailedError(error: z.ZodError): ApiError {
  return new ApiError(ErrorCode.VALIDATION_FAILED, "Invalid request parameters", {
    status: 400,
    details: toValidationDetails(error),
  });
}

export function validateRequest(schemas: RequestSchemas) {
  return (req: Request, res: Response, next: NextFunction) => {
    const invalidParams: InvalidParam[] = [];
    const validated: ValidatedRequest = {};

    for (const source of SOURCES) {
      const schema = schemas[source];
      if (!schema) continue;
      const result = schema.safeParse(req[source] ?? {});
      if (result.success) {
        validated[source] = result.data;
      } else {
        invalidParams.push(...toInvalidParams(result.error));
      }
    }

    if (invalidParams.length > 0) {
      const details = invalidParams.map((p) => ({ path: p.name, message: p.reason }));
      next(
        new ApiError(ErrorCode.VALIDATION_FAILED, "Invalid request parameters", {
          status: 400,
          details,
        }),
      );
      return;
    }

    res.locals.validated = validated;
    next();
  };
}

/**
 * Test helper: asserts a controller response matches its documented schema,
 * so contract drift fails the test suite. Throws with the offending fields.
 */
export function assertResponseMatches<T>(schema: z.ZodType<T>, payload: unknown): T {
  const result = schema.safeParse(payload);
  if (!result.success) {
    const fields = toInvalidParams(result.error).map((p) => `${p.name}: ${p.reason}`);
    throw new Error(`Response does not match schema — ${fields.join("; ")}`);
  }
  return result.data;
}
