import { Router } from 'express';
import { prisma } from '../../lib/prisma.js';
import { verifyJwt } from '../../middleware/auth.js';

const router = Router();

router.use((req, res, next) => {
  res.set('Cache-Control', 'no-store');
  const authorization = req.headers.authorization;
  const wallet = authorization?.startsWith('Bearer ') && verifyJwt(authorization.slice(7), true);
  if (!wallet) {
    res.status(401).json({ error: 'A valid wallet access token is required' });
    return;
  }
  res.locals.walletAddress = wallet.publicKey;
  next();
});

/**
 * @openapi
 * /v1/privacy/export:
 *   post:
 *     tags: [Privacy]
 *     summary: Export eligible off-chain data
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       '200':
 *         description: Download containing a completion receipt and webhook records
 *       '401':
 *         description: A valid wallet access token is required
 *       '503':
 *         description: Operation unavailable. Retry the request.
 */
router.post('/export', async (req, res) => {
  const walletAddress: string = res.locals.walletAddress;
  try {
    const data = await prisma.$transaction(async (tx) => {
      const subscriptions = await tx.webhookSubscription.findMany({
        where: { userAddress: walletAddress },
        orderBy: { id: 'asc' },
        select: {
          id: true,
          targetUrl: true,
          eventTypes: true,
          isActive: true,
          createdAt: true,
          updatedAt: true,
          deliveries: {
            orderBy: { id: 'asc' },
            select: {
              id: true,
              eventType: true,
              attempts: true,
              responseStatus: true,
              deliveredAt: true,
              createdAt: true,
            },
          },
        },
      });
      const receipt = await tx.privacyReceipt.create({
        data: {
          walletAddress,
          operation: 'export',
          subscriptions: subscriptions.length,
          deliveries: subscriptions.reduce((total, sub) => total + sub.deliveries.length, 0),
        },
      });
      return { receipt, subscriptions };
    }, { isolationLevel: 'RepeatableRead' });
    res.attachment('flowfi-data-export.json').json(data);
  } catch {
    res.status(503).json({ status: 'incomplete', error: 'Data export failed. Retry the request.' });
  }
});

/**
 * @openapi
 * /v1/privacy/deletion:
 *   post:
 *     tags: [Privacy]
 *     summary: Delete eligible off-chain data
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [confirm]
 *             properties:
 *               confirm: { type: boolean, enum: [true] }
 *     responses:
 *       '200':
 *         description: Completion receipt with deletion counts
 *       '400':
 *         description: Missing deletion confirmation
 *       '401':
 *         description: A valid wallet access token is required
 *       '503':
 *         description: Operation unavailable. Retry the request.
 */
router.post('/deletion', async (req, res) => {
  const walletAddress: string = res.locals.walletAddress;
  if (req.body?.confirm !== true) {
    res.status(400).json({ error: 'Deletion requires confirm: true' });
    return;
  }
  try {
    const receipt = await prisma.$transaction(async (tx) => {
      const { count: deliveries } = await tx.webhookDelivery.deleteMany({
        where: { subscription: { userAddress: walletAddress } },
      });
      const { count: subscriptions } = await tx.webhookSubscription.deleteMany({
        where: { userAddress: walletAddress },
      });
      return tx.privacyReceipt.create({
        data: { walletAddress, operation: 'deletion', subscriptions, deliveries },
      });
    }, { isolationLevel: 'Serializable' });
    res.json({ status: 'complete', receipt });
  } catch {
    res.status(503).json({ status: 'incomplete', error: 'Data deletion failed. Retry the request.' });
  }
});

/**
 * @openapi
 * /v1/privacy/receipts/{id}:
 *   get:
 *     tags: [Privacy]
 *     summary: Look up a privacy receipt
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       '200':
 *         description: Completion receipt
 *       '404':
 *         description: Receipt not found
 *       '401':
 *         description: A valid wallet access token is required
 *       '503':
 *         description: Operation unavailable. Retry the request.
 */
router.get('/receipts/:id', async (req, res) => {
  const walletAddress: string = res.locals.walletAddress;
  try {
    const receipt = await prisma.privacyReceipt.findFirst({
      where: { id: req.params.id, walletAddress },
    });
    if (!receipt) {
      res.status(404).json({ error: 'Receipt not found' });
      return;
    }
    res.json({ status: 'complete', receipt });
  } catch {
    res.status(503).json({ error: 'Receipt lookup failed. Retry the request.' });
  }
});

export default router;
