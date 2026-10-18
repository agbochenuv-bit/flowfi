import { Router } from 'express';
import { issueChallenge, verifyChallenge } from '../../middleware/auth.js';

const router = Router();

/**
 * @openapi
 * /v1/auth/challenge:
 *   post:
 *     tags: [Auth]
 *     summary: Request a sign challenge for wallet authentication
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [publicKey]
 *             properties:
 *               publicKey:
 *                 type: string
 *                 example: GABC...
 *               audience:
 *                 type: string
 *                 description: >-
 *                   Optional intended audience for the challenge. Defaults to the
 *                   server-configured audience when omitted.
 *                 example: app.example.com
 *               network:
 *                 type: string
 *                 description: >-
 *                   Optional Stellar network binding (e.g. "testnet", "public").
 *                   Defaults to the server-configured network when omitted.
 *                 example: testnet
 *     responses:
 *       200:
 *         description: >-
 *           Challenge nonce issued. The response echoes the effective audience
 *           and network the challenge is bound to.
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/AuthChallengeResponse'
 *       400:
 *         description: Invalid publicKey, audience, or network
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *       429:
 *         description: Too many requests
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 */
router.post('/challenge', (req, res, next) =>
  issueChallenge(req, res, next, {
    audience: req.body?.audience,
    network: req.body?.network,
  }),
);

/**
 * @openapi
 * /v1/auth/verify:
 *   post:
 *     tags: [Auth]
 *     summary: Verify signed challenge and receive JWT
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [publicKey, signedTransaction]
 *             properties:
 *               publicKey:
 *                 type: string
 *               signedTransaction:
 *                 type: string
 *                 description: Base64-encoded XDR signed transaction containing the nonce
 *               audience:
 *                 type: string
 *                 description: >-
 *                   Optional audience the challenge was requested for. Must match
 *                   the audience bound at challenge issuance.
 *               network:
 *                 type: string
 *                 description: >-
 *                   Optional network the challenge was requested for. Must match
 *                   the network bound at challenge issuance.
 *     responses:
 *       200:
 *         description: JWT token
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/AuthVerifyResponse'
 *       400:
 *         description: Missing or malformed publicKey, signedTransaction, audience, or network
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *       401:
 *         description: >-
 *           Invalid signature, expired challenge, reused (already consumed)
 *           challenge, or challenge bound to a different wallet, audience, or
 *           network than the one presented.
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *       429:
 *         description: Too many requests
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 */
router.post('/verify', (req, res, next) =>
  verifyChallenge(req, res, next, {
    audience: req.body?.audience,
    network: req.body?.network,
  }),
);

export default router;
