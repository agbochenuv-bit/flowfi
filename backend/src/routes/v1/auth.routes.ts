import { Router } from 'express';
import { issueChallenge, verifyChallenge, requireAuth } from '../../middleware/auth.js';
import { listSessions, revokeSession } from '../../middleware/auth.js';

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

/**
 * @openapi
 * /v1/auth/sessions:
 *   get:
 *     tags: [Auth]
 *     summary: List active wallet-authenticated sessions
 *     description: >-
 *       Returns the sessions currently associated with the authenticated wallet.
 *       Only non-secret session metadata is exposed (session identifier, wallet
 *       public key, issuance and expiry timestamps, and last-seen information).
 *       Signing secrets and challenge nonces are never stored or returned.
 *
 *       Session lifecycle: a session is created on successful `/v1/auth/verify`
 *       and remains valid until it expires or is explicitly revoked. Expiry is
 *       enforced on every authenticated request; expired sessions are rejected
 *       with `401` and are not listed as active.
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Active sessions for the authenticated wallet
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 sessions:
 *                   type: array
 *                   items:
 *                     $ref: '#/components/schemas/AuthSession'
 *       401:
 *         description: Missing, invalid, expired, or revoked session token
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 */
router.get('/sessions', requireAuth, listSessions);

/**
 * @openapi
 * /v1/auth/sessions/{sessionId}:
 *   delete:
 *     tags: [Auth]
 *     summary: Revoke a wallet-authenticated session
 *     description: >-
 *       Immediately revokes the identified session. Revocation takes effect
 *       across all interfaces: subsequent API requests bearing the revoked
 *       session token are rejected with `401`, and any open SSE streams bound to
 *       that session are terminated. A wallet may only revoke its own sessions;
 *       attempts to revoke a session belonging to another wallet return `404`.
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: sessionId
 *         required: true
 *         schema:
 *           type: string
 *         description: Identifier of the session to revoke
 *     responses:
 *       204:
 *         description: Session revoked (idempotent for already-revoked sessions)
 *       401:
 *         description: Missing, invalid, expired, or revoked session token
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *       404:
 *         description: Session not found for the authenticated wallet
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 */
router.delete('/sessions/:sessionId', requireAuth, revokeSession);

export default router;
