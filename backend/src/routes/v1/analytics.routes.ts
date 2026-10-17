/**
 * Analytics routes (#1480) — public protocol statistics.
 *
 * - GET /tvl        — current TVL partitioned by token
 * - GET /historical — pre-aggregated chart series (`?period=&interval=`)
 * - GET /defillama  — DefiLlama adapter payload
 *
 * Rate limiting (#72):
 * All analytics routes are guarded by the principal-aware limiter using the
 * analytics-specific budget. Callers are keyed by authenticated principal when
 * available, otherwise by client IP (honoring trusted proxy configuration).
 * When Redis is unavailable the limiter falls back to a safe in-process budget.
 *
 * On budget exhaustion the limiter responds with HTTP 429 and the standard
 * envelope:
 *
 *   {
 *     "error": {
 *       "code": "RATE_LIMITED",
 *       "message": "Too many requests, please try again later.",
 *       "retryAfter": <seconds>
 *     }
 *   }
 *
 * The `Retry-After` header is also set to the number of seconds until the
 * caller's budget window resets.
 */

import { Router } from "express";
import {
  getDefiLlamaHandler,
  getHistoricalHandler,
  getTvlHandler,
} from "../../controllers/analytics.controller.js";
import { principalRateLimiter } from "../../middleware/principalRateLimiter.js";

const router = Router();

const analyticsLimiter = principalRateLimiter("analytics");

router.get("/tvl", analyticsLimiter, getTvlHandler);
router.get("/historical", analyticsLimiter, getHistoricalHandler);
router.get("/defillama", analyticsLimiter, getDefiLlamaHandler);

export default router;