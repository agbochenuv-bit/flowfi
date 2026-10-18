/**
 * Analytics routes (#1480) — public protocol statistics.
 *
 * - GET /tvl        — current TVL partitioned by token
 * - GET /historical — pre-aggregated chart series (`?period=&interval=`)
 * - GET /defillama  — DefiLlama adapter payload
 *
 * Time-window & timezone semantics (#61):
 * - All time boundaries are computed in UTC. `period`/`interval` windows are
 *   inclusive of their start and exclusive of their end bucket, so aggregates
 *   are repeatable regardless of the caller's local timezone.
 * - Events indexed after an initial query are incorporated on subsequent
 *   queries (late-arriving indexed events are not dropped).
 *
 * Caching & staleness (#62):
 * - Aggregate responses are cached with bounded keys scoped by network, time
 *   range, and filters. Cache keys never cross networks or users.
 * - Cached entries are invalidated when newly indexed events arrive, or expire
 *   after a documented staleness window.
 *
 * Optional `network` query parameter:
 * - `GET /tvl?network=<id>` and `GET /historical?network=<id>` scope results to
 *   a single network. When omitted, results cover all networks (aggregate).
 *   The `network` value participates in the cache key, so responses for
 *   different networks are never shared.
 */

import { Router } from "express";
import {
  getDefiLlamaHandler,
  getHistoricalHandler,
  getTvlHandler,
} from "../../controllers/analytics.controller.js";

const router = Router();

/**
 * @openapi
 * /v1/analytics/tvl:
 *   get:
 *     summary: Current TVL partitioned by token
 *     description: >
 *       Returns current total value locked partitioned by token. All time
 *       boundaries are computed in UTC and are independent of the caller's
 *       local timezone. Results are cached with bounded keys scoped by
 *       network and filters; entries are invalidated when newly indexed
 *       events arrive or expire after the documented staleness window.
 *     parameters:
 *       - in: query
 *         name: network
 *         required: false
 *         schema:
 *           type: string
 *         description: >
 *           Optional network identifier. When provided, results are scoped to
 *           that network; when omitted, results cover all networks. The value
 *           is part of the cache key, so responses never cross networks.
 *     responses:
 *       '200':
 *         description: TVL partitioned by token.
 */
router.get("/tvl", getTvlHandler);

/**
 * @openapi
 * /v1/analytics/historical:
 *   get:
 *     summary: Pre-aggregated historical chart series
 *     description: >
 *       Returns pre-aggregated chart series. `period` and `interval` windows
 *       are computed in UTC; each bucket is inclusive of its start and
 *       exclusive of its end. Events indexed after an initial query are
 *       incorporated on subsequent queries. Results are cached with bounded
 *       keys scoped by network, time range, and filters; entries are
 *       invalidated when newly indexed events arrive or expire after the
 *       documented staleness window.
 *     parameters:
 *       - in: query
 *         name: period
 *         required: false
 *         schema:
 *           type: string
 *         description: Time window for the series (UTC boundaries).
 *       - in: query
 *         name: interval
 *         required: false
 *         schema:
 *           type: string
 *         description: Bucket interval for the series (UTC boundaries).
 *       - in: query
 *         name: network
 *         required: false
 *         schema:
 *           type: string
 *         description: >
 *           Optional network identifier. When provided, results are scoped to
 *           that network; when omitted, results cover all networks. The value
 *           is part of the cache key, so responses never cross networks.
 *     responses:
 *       '200':
 *         description: Pre-aggregated historical series.
 */
router.get("/historical", getHistoricalHandler);

/**
 * @openapi
 * /v1/analytics/defillama:
 *   get:
 *     summary: DefiLlama adapter payload
 *     description: >
 *       Returns the DefiLlama-compatible adapter payload. Time boundaries are
 *       computed in UTC. Results are cached with bounded keys and invalidated
 *       when newly indexed events arrive or after the documented staleness
 *       window.
 *     responses:
 *       '200':
 *         description: DefiLlama adapter payload.
 */
router.get("/defillama", getDefiLlamaHandler);

export default router;