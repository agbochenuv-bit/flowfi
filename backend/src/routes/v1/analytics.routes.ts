import { Router } from 'express';
import {
  getTvlHandler,
  getHistoricalHandler,
  getDefiLlamaHandler,
} from '../../controllers/analytics.controller.js';

const router = Router();

/**
 * @openapi
 * /v1/analytics/tvl:
 *   get:
 *     tags: [Analytics]
 *     summary: Current protocol TVL partitioned by token asset
 *     description: |
 *       Returns the current Total Value Locked (TVL) for the FlowFi protocol,
 *       broken down by token asset. Responses include cache metadata so clients
 *       can observe the staleness contract.
 *     parameters:
 *       - in: query
 *         name: network
 *         schema: { type: string }
 *         description: Stellar network scope (omit for default)
 *     responses:
 *       200:
 *         description: Current TVL snapshot
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success: { type: boolean }
 *                 data:
 *                   type: object
 *                 meta:
 *                   type: object
 *                   properties:
 *                     source: { type: string }
 *                     cached: { type: boolean }
 *                     generatedAt: { type: string, format: date-time }
 *       400:
 *         description: Invalid network parameter
 *       503:
 *         description: Analytics unavailable
 */
router.get('/tvl', getTvlHandler);

/**
 * @openapi
 * /v1/analytics/historical:
 *   get:
 *     tags: [Analytics]
 *     summary: Pre-aggregated time-series data for frontend charts
 *     parameters:
 *       - in: query
 *         name: period
 *         schema: { type: string, enum: [7d, 30d, 90d, 1y], default: 30d }
 *         description: Lookback window
 *       - in: query
 *         name: interval
 *         schema: { type: string, enum: [1h, 1d], default: 1d }
 *         description: Bucket size
 *       - in: query
 *         name: network
 *         schema: { type: string }
 *         description: Stellar network scope (omit for default)
 *     responses:
 *       200:
 *         description: Time-series analytics data
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success: { type: boolean }
 *                 data:
 *                   type: array
 *                   items: { type: object }
 *                 meta:
 *                   type: object
 *       400:
 *         description: Invalid period, interval, or network parameter
 *       503:
 *         description: Analytics unavailable
 */
router.get('/historical', getHistoricalHandler);

/**
 * @openapi
 * /v1/analytics/defillama:
 *   get:
 *     tags: [Analytics]
 *     summary: DefiLlama protocol-TVL adapter response
 *     description: |
 *       Returns a standardised DefiLlama TVL adapter object. Cache metadata
 *       is attached additively under `meta` so existing DefiLlama consumers
 *       are unaffected.
 *     parameters:
 *       - in: query
 *         name: network
 *         schema: { type: string }
 *         description: Stellar network scope (omit for default)
 *     responses:
 *       200:
 *         description: DefiLlama adapter response
 *       400:
 *         description: Invalid network parameter
 *       503:
 *         description: Analytics unavailable
 */
router.get('/defillama', getDefiLlamaHandler);

export default router;
