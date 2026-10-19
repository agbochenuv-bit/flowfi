import { Router } from 'express';
import { requireAuth } from '../../middleware/auth.js';
import { getUserStreamSummary } from '../../controllers/stream.controller.js';

const router = Router();

/**
 * @openapi
 * /v1/users/{address}/streams/summary:
 *   get:
 *     tags: [Users]
 *     summary: Aggregate stream statistics for a wallet address
 *     description: |
 *       Returns counts, totals, and claimable balance aggregated across all
 *       streams where the address is sender or recipient. Results are cached
 *       for 30 seconds. When a wallet has more than 500 streams in either
 *       direction the response includes `truncated: true`.
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: address
 *         required: true
 *         schema: { type: string }
 *         description: Stellar wallet public key (G...)
 *     responses:
 *       200:
 *         description: User stream summary
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 address:
 *                   type: string
 *                 totalStreamsCreated:
 *                   type: integer
 *                 totalStreamedOut:
 *                   type: string
 *                   description: Total amount withdrawn from outgoing streams (i128 as string)
 *                 totalStreamedIn:
 *                   type: string
 *                   description: Total amount received from incoming streams (i128 as string)
 *                 currentClaimable:
 *                   type: string
 *                   description: Currently claimable balance across all incoming streams (i128 as string)
 *                 activeOutgoingCount:
 *                   type: integer
 *                 activeIncomingCount:
 *                   type: integer
 *                 truncated:
 *                   type: boolean
 *                   description: Present and true when the stream cap (500) was reached
 *       400:
 *         description: Invalid address
 *       401:
 *         description: Unauthorized
 */
router.get('/:address/streams/summary', requireAuth, getUserStreamSummary);

export default router;
