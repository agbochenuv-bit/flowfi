import type { Response } from "express";
import { ApiError } from "../lib/api-error.js";

export type { ApiErrorBody } from "../lib/api-error.js";
export { ApiError };

export function sendApiError(
  res: Response,
  statusCode: number,
  code: string,
  message: string,
  details?: unknown,
) {
  const error: { code: string; message: string; details?: unknown } = { code, message };
  if (details !== undefined) error.details = details;
  return res.status(statusCode).json({ error });
}