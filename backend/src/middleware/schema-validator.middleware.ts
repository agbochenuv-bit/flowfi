import type { NextFunction, Request, Response } from "express";
import { z } from "zod";

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
 * Rejects query parameters that are not declared by the query schema, so
 * undocumented input cannot silently reach controllers. Only object-shaped
 * schemas are inspected; other shapes are left to the schema itself.
 */
function undocumentedQueryParams(schema: z.ZodType, query: unknown): InvalidParam[] {
  const shape = (schema as { shape?: unknown }).shape;
  if (!shape || typeof shape !== "object") return [];
  if (!query || typeof query !== "object") return [];

  const allowed = new Set(Object.keys(shape as Record<string, unknown>));
  const invalidParams: InvalidParam[] = [];
  for (const name of Object.keys(query as Record<string, unknown>)) {
    if (!allowed.has(name)) {
      invalidParams.push({ name, reason: "Unknown query parameter" });
    }
  }
  return invalidParams;
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

export function validateRequest(schemas: RequestSchemas) {
  return (req: Request, res: Response, next: NextFunction) => {
    const invalidParams: InvalidParam[] = [];
    const validated: ValidatedRequest = {};

    for (const source of SOURCES) {
      const schema = schemas[source];
      if (!schema) continue;
      const input = req[source] ?? {};
      const result = schema.safeParse(input);
      if (result.success) {
        if (source === "query") {
          invalidParams.push(...undocumentedQueryParams(schema, input));
        }
        validated[source] = result.data;
      } else {
        invalidParams.push(...toInvalidParams(result.error));
      }
    }

    if (invalidParams.length > 0) {
      res.status(400).type("application/problem+json").json(invalidParametersProblem(invalidParams));
      return;
    }

    res.locals.validated = validated;
    next();
  };
}

/**
 * Wraps a route handler so synchronous throws and rejected promises are
 * forwarded to `next`, letting the centralized error handler map status codes
 * instead of leaking stack traces from Express 5's default handler.
 */
export function withValidation<T extends (req: Request, res: Response, next: NextFunction) => unknown>(
  handler: T,
) {
  return (req: Request, res: Response, next: NextFunction) => {
    try {
      const result = handler(req, res, next);
      if (result && typeof (result as Promise<unknown>).catch === "function") {
        (result as Promise<unknown>).catch(next);
      }
    } catch (error) {
      next(error);
    }
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
