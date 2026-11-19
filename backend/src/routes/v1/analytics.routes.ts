import { Router } from 'express';
import {
  getTvlHandler,
  getHistoricalHandler,
  getDefiLlamaHandler,
} from '../../controllers/analytics.controller.js';
import {
  createExportHandler,
  getExportHandler,
  cancelExportHandler,
  downloadExportHandler,
  getActivityExportHandler,
} from '../../controllers/export.controller.js';
import { createCostBudgetMiddleware } from '../../middleware/costBudget.middleware.js';

const router = Router();

/**
 * Per-route cost units (issue #250).
 *
 * Every request to the analytics/export surface is charged a weighted number
 * of cost units against the caller's rolling budget. Cheap reads cost 1 unit;
 * expensive reads (analytics aggregation, exports, multi-resource queries)
 * cost more. When the budget is exhausted the API responds with HTTP 429 and
 * the standard error envelope:
 *
 *   {
 *     "success": false,
 *     "error": {
 *       "code": "COST_BUDGET_EXCEEDED",
 *       "message": "Request cost budget exceeded",
 *       "details": { "cost": 10, "limit": 100, "remaining": 0, "retryAfter": 30 }
 *     }
 *   }
 *
 * Cost units per route:
 *   GET  /v1/analytics/tvl              1
 *   GET  /v1/analytics/historical       5
 *   GET  /v1/analytics/defillama        1
 *   GET  /v1/exports/activity           5
 *   POST /v1/exports                   10
 *   GET  /v1/exports/:jobId             1
 *   POST /v1/exports/:jobId/cancel      1
 *   GET  /v1/exports/:jobId/download    5
 */

const tvlBudget = createCostBudgetMiddleware({ route: 'analytics.tvl', cost: 1 });
const historicalBudget = createCostBudgetMiddleware({ route: 'analytics.historical', cost: 5 });
const defiLlamaBudget = createCostBudgetMiddleware({ route: 'analytics.defillama', cost: 1 });

const activityExportBudget = createCostBudgetMiddleware({ route: 'exports.activity', cost: 5 });
const createExportBudget = createCostBudgetMiddleware({ route: 'exports.create', cost: 10 });
const getExportBudget = createCostBudgetMiddleware({ route: 'exports.get', cost: 1 });
const cancelExportBudget = createCostBudgetMiddleware({ route: 'exports.cancel', cost: 1 });
const downloadExportBudget = createCostBudgetMiddleware({ route: 'exports.download', cost: 5 });

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
 *       429:
 *         description: Request cost budget exceeded
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success: { type: boolean, example: false }
 *                 error:
 *                   type: object
 *                   properties:
 *                     code: { type: string, example: COST_BUDGET_EXCEEDED }
 *                     message: { type: string }
 *                     details:
 *                       type: object
 *                       properties:
 *                         cost: { type: integer }
 *                         limit: { type: integer }
 *                         remaining: { type: integer }
 *                         retryAfter: { type: integer }
 *       503:
 *         description: Analytics unavailable
 */
router.get('/tvl', tvlBudget, getTvlHandler);

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
 *       429:
 *         description: Request cost budget exceeded (cost 5 units)
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success: { type: boolean, example: false }
 *                 error:
 *                   type: object
 *                   properties:
 *                     code: { type: string, example: COST_BUDGET_EXCEEDED }
 *                     message: { type: string }
 *                     details:
 *                       type: object
 *                       properties:
 *                         cost: { type: integer }
 *                         limit: { type: integer }
 *                         remaining: { type: integer }
 *                         retryAfter: { type: integer }
 *       503:
 *         description: Analytics unavailable
 */
router.get('/historical', historicalBudget, getHistoricalHandler);

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
 *       429:
 *         description: Request cost budget exceeded
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success: { type: boolean, example: false }
 *                 error:
 *                   type: object
 *                   properties:
 *                     code: { type: string, example: COST_BUDGET_EXCEEDED }
 *                     message: { type: string }
 *                     details:
 *                       type: object
 *                       properties:
 *                         cost: { type: integer }
 *                         limit: { type: integer }
 *                         remaining: { type: integer }
 *                         retryAfter: { type: integer }
 *       503:
 *         description: Analytics unavailable
 */
router.get('/defillama', defiLlamaBudget, getDefiLlamaHandler);

/**
 * @openapi
 * /v1/exports/activity:
 *   get:
 *     tags: [Exports]
 *     summary: Synchronous wallet activity export (accounting-friendly)
 *     description: |
 *       Returns a reproducible export of stream lifecycle and payment records
 *       owned by the authenticated wallet. Each row carries explicit units,
 *       network identifiers and transaction references.
 *
 *       **Column schema** (CSV header order):
 *       | column | type | description |
 *       | --- | --- | --- |
 *       | `record_type` | string | `stream` or `payment` |
 *       | `record_id` | string | Stable record identifier |
 *       | `stream_id` | string | Parent stream id |
 *       | `network` | string | Stellar network (`mainnet`/`testnet`/`futurenet`) |
 *       | `asset_code` | string | Asset code (e.g. `USDC`) |
 *       | `asset_issuer` | string | Asset issuer account |
 *       | `amount` | string | Decimal amount in asset units (7 dp) |
 *       | `amount_stroops` | string | Integer amount in stroops (1e-7 units) |
 *       | `occurred_at` | string | ISO-8601 UTC timestamp |
 *       | `tx_hash` | string | Stellar transaction hash |
 *       | `ledger` | integer | Ledger sequence |
 *
 *       **Timezone rules:** all timestamps are emitted in UTC (ISO-8601 with a
 *       trailing `Z`). `from`/`to` query parameters are interpreted as UTC and
 *       are inclusive of `from`, exclusive of `to`.
 *
 *       Only records owned by the authenticated wallet are returned; records
 *       belonging to other wallets are never included.
 *     parameters:
 *       - in: query
 *         name: format
 *         schema: { type: string, enum: [csv, json], default: csv }
 *       - in: query
 *         name: from
 *         schema: { type: string, format: date-time }
 *         description: Inclusive UTC lower bound
 *       - in: query
 *         name: to
 *         schema: { type: string, format: date-time }
 *         description: Exclusive UTC upper bound
 *       - in: query
 *         name: network
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: Export payload (CSV or JSON)
 *       400:
 *         description: Invalid format, time range, or network
 *       401:
 *         description: Missing or invalid wallet authentication
 *       429:
 *         description: Request cost budget exceeded (cost 5 units)
 *       503:
 *         description: Export service unavailable
 */
router.get('/exports/activity', activityExportBudget, getActivityExportHandler);

/**
 * @openapi
 * /v1/exports:
 *   post:
 *     tags: [Exports]
 *     summary: Create a resumable asynchronous export job
 *     description: |
 *       Enqueues a bounded export job owned by the authenticated wallet.
 *       Jobs expire after `expiresAt`; only the owning wallet may poll,
 *       cancel, or download the job. Downloads require a valid job token and
 *       ownership check.
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [kind]
 *             properties:
 *               kind: { type: string, enum: [activity, payments] }
 *               format: { type: string, enum: [csv, json], default: csv }
 *               from: { type: string, format: date-time }
 *               to: { type: string, format: date-time }
 *               network: { type: string }
 *     responses:
 *       202:
 *         description: Export job accepted
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success: { type: boolean }
 *                 data:
 *                   type: object
 *                   properties:
 *                     jobId: { type: string }
 *                     status: { type: string, enum: [queued, running, completed, failed, cancelled, expired] }
 *                     expiresAt: { type: string, format: date-time }
 *                     downloadUrl: { type: string, nullable: true }
 *       400:
 *         description: Invalid export request
 *       401:
 *         description: Missing or invalid wallet authentication
 *       429:
 *         description: Request cost budget exceeded (cost 10 units)
 */
router.post('/exports', createExportBudget, createExportHandler);

/**
 * @openapi
 * /v1/exports/{jobId}:
 *   get:
 *     tags: [Exports]
 *     summary: Poll an export job
 *     description: |
 *       Returns the current status of an export job. Only the owning wallet
 *       may read the job; other callers receive 404 to avoid leaking job
 *       existence. Expired jobs report `status: expired`.
 *     parameters:
 *       - in: path
 *         name: jobId
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: Job status
 *       401:
 *         description: Missing or invalid wallet authentication
 *       404:
 *         description: Job not found or not owned by caller
 *       429:
 *         description: Request cost budget exceeded (cost 1 unit)
 */
router.get('/exports/:jobId', getExportBudget, getExportHandler);

/**
 * @openapi
 * /v1/exports/{jobId}/cancel:
 *   post:
 *     tags: [Exports]
 *     summary: Cancel an export job
 *     description: |
 *       Requests cancellation of a queued or running export job. Only the
 *       owning wallet may cancel. Completed jobs cannot be cancelled.
 *     parameters:
 *       - in: path
 *         name: jobId
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: Job cancelled
 *       401:
 *         description: Missing or invalid wallet authentication
 *       404:
 *         description: Job not found or not owned by caller
 *       409:
 *         description: Job already completed or expired
 *       429:
 *         description: Request cost budget exceeded (cost 1 unit)
 */
router.post('/exports/:jobId/cancel', cancelExportBudget, cancelExportHandler);

/**
 * @openapi
 * /v1/exports/{jobId}/download:
 *   get:
 *     tags: [Exports]
 *     summary: Download a completed export job
 *     description: |
 *       Streams the completed export payload. Download authorization requires
 *       the caller to own the job and the job to be in `completed` state and
 *       not expired. The column schema matches `GET /v1/exports/activity`.
 *     parameters:
 *       - in: path
 *         name: jobId
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: Export payload (CSV or JSON)
 *       401:
 *         description: Missing or invalid wallet authentication
 *       404:
 *         description: Job not found or not owned by caller
 *       409:
 *         description: Job not completed, cancelled, or expired
 *       429:
 *         description: Request cost budget exceeded (cost 5 units)
 */
router.get('/exports/:jobId/download', downloadExportBudget, downloadExportHandler);

export default router;
