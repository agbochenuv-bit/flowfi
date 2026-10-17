import { Router } from "express";
import { z } from "zod";
import {
  registerUser,
  getUser,
  getUserEvents,
  getCurrentUser,
  exportTransactions,
} from "../../controllers/user.controller.js";
import { getUserStreamSummary } from "../../controllers/stream.controller.js";
import { requireAuth } from "../../middleware/auth.js";
import { validateRequest } from "../../middleware/validateRequest.js";
import { requireWalletOwnership } from "../../middleware/requireWalletOwnership.js";

const router = Router();

const publicKeyParam = z.object({
  publicKey: z.string().min(1, "publicKey is required"),
});

const addressParam = z.object({
  address: z.string().min(1, "address is required"),
});

const registerUserBody = z.object({
  publicKey: z.string().min(1, "publicKey is required"),
});

const userEventsQuery = z.object({
  limit: z.coerce.number().int().min(1).max(200).optional(),
  offset: z.coerce.number().int().min(0).optional(),
});

const exportQuery = z.object({
  format: z.enum(["csv", "json"]).optional(),
  direction: z.enum(["incoming", "outgoing", "all"]).optional(),
  startDate: z.string().optional(),
  endDate: z.string().optional(),
  tokenAddress: z.string().optional(),
});

/**
 * @openapi
 * /v1/users:
 *   post:
 *     tags:
 *       - Users
 *     summary: Register a wallet public key
 *     description: Registers a new Stellar wallet public key or returns the existing user if already registered.
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - publicKey
 *             properties:
 *               publicKey:
 *                 type: string
 *                 description: Stellar public key (G...)
 *                 example: "GABC123XYZ456DEF789GHI012JKL345MNO678PQR901STU234VWX567YZA"
 *     responses:
 *       201:
 *         description: User registered successfully
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/User'
 *       200:
 *         description: User already exists
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/User'
 *       400:
 *         description: Invalid request body
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *       500:
 *         description: Internal server error
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *
 * /v1/users/{publicKey}:
 *   get:
 *     tags:
 *       - Users
 *     summary: Fetch a user by public key
 *     description: Returns user details along with recent sent and received streams.
 *     parameters:
 *       - in: path
 *         name: publicKey
 *         required: true
 *         schema:
 *           type: string
 *         description: Stellar public key
 *     responses:
 *       200:
 *         description: User found
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/User'
 *       401:
 *         description: Unauthorized - missing or invalid token
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *       403:
 *         description: Forbidden - wallet does not own this resource
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *       404:
 *         description: User not found
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *       500:
 *         description: Internal server error
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *
 * /v1/users/me:
 *   get:
 *     tags:
 *       - Users
 *     summary: Get current authenticated user
 *     description: Returns the currently authenticated user's details (protected endpoint)
 *     security:
 *       - BearerAuth: []
 *     responses:
 *       200:
 *         description: Current user details
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/User'
 *       401:
 *         description: Unauthorized - invalid or missing token
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *       500:
 *         description: Internal server error
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 */
router.post("/", validateRequest({ body: registerUserBody }), registerUser);
router.get("/me", requireAuth, getCurrentUser);
/**
 * @openapi
 * /v1/users/{address}/summary:
 *   get:
 *     tags:
 *       - Users
 *     summary: Get aggregate stream summary for a user
 *     description: |
 *       Returns dashboard/profile summary data for a wallet address:
 *       total created streams, total streamed out/in, current claimable across
 *       active incoming streams, and active stream counts.
 *
 *       Response is cached for 30 seconds to reduce DB load.
 *     parameters:
 *       - in: path
 *         name: address
 *         required: true
 *         schema:
 *           type: string
 *         description: Stellar public key address
 *     responses:
 *       200:
 *         description: User stream summary
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/UserStreamSummary'
 *       400:
 *         description: Address is required
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *       500:
 *         description: Internal server error
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 */
router.get(
  "/:address/summary",
  validateRequest({ params: addressParam }),
  getUserStreamSummary,
);
router.get(
  "/:publicKey",
  requireAuth,
  validateRequest({ params: publicKeyParam }),
  requireWalletOwnership("publicKey"),
  getUser,
);

/**
 * @openapi
 * /v1/users/{publicKey}/events:
 *   get:
 *     tags:
 *       - Users
 *     summary: Fetch user activity history
 *     description: Returns a paginated chronological history of all stream events associated with the user.
 *     parameters:
 *       - in: path
 *         name: publicKey
 *         required: true
 *         schema:
 *           type: string
 *         description: Stellar public key
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *           default: 50
 *           maximum: 200
 *         description: Maximum number of events to return
 *       - in: query
 *         name: offset
 *         schema:
 *           type: integer
 *           default: 0
 *         description: Number of events to skip for pagination
 *     responses:
 *       200:
 *         description: Paginated list of user events
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/UserEventListResponse'
 *       400:
 *         description: Invalid pagination parameters
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *       401:
 *         description: Unauthorized - missing or invalid token
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *       403:
 *         description: Forbidden - wallet does not own this resource
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *       404:
 *         description: User not found
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *       500:
 *         description: Internal server error
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 */
router.get(
  "/:publicKey/events",
  requireAuth,
  validateRequest({ params: publicKeyParam, query: userEventsQuery }),
  requireWalletOwnership("publicKey"),
  getUserEvents,
);

export default router;

/**
 * @openapi
 * /v1/users/{address}/export:
 *   get:
 *     tags:
 *       - Users
 *     summary: Export transaction history for tax and accounting
 *     description: Generates CSV or JSON export of stream transactions for QuickBooks, Xero, CoinTracker, etc.
 *     parameters:
 *       - in: path
 *         name: address
 *         required: true
 *         schema:
 *           type: string
 *         description: Stellar public key
 *       - in: query
 *         name: format
 *         schema:
 *           type: string
 *           enum: [csv, json]
 *           default: csv
 *         description: Export format
 *       - in: query
 *         name: direction
 *         schema:
 *           type: string
 *           enum: [incoming, outgoing, all]
 *           default: all
 *         description: Filter by transaction direction
 *       - in: query
 *         name: startDate
 *         schema:
 *           type: string
 *           format: date-time
 *         description: Start date (ISO 8601 or Unix timestamp)
 *       - in: query
 *         name: endDate
 *         schema:
 *           type: string
 *           format: date-time
 *         description: End date (ISO 8601 or Unix timestamp)
 *       - in: query
 *         name: tokenAddress
 *         schema:
 *           type: string
 *         description: Filter by specific token contract
 *     responses:
 *       200:
 *         description: Transaction export file
 *         content:
 *           text/csv:
 *             schema:
 *               type: string
 *               format: binary
 *           application/json:
 *             schema:
 *               type: object
 *       400:
 *         description: Invalid parameters
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *       401:
 *         description: Unauthorized - missing or invalid token
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *       403:
 *         description: Forbidden - wallet does not own this resource
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *       404:
 *         description: User not found
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *       500:
 *         description: Internal server error
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 */
router.get(
  "/:address/export",
  requireAuth,
  validateRequest({ params: addressParam, query: exportQuery }),
  requireWalletOwnership("address"),
  exportTransactions,
);
