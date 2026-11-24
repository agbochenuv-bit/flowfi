import { Router, type Request, type Response } from 'express';
import {
  requireAuth,
  requireWalletSessionAuth,
} from '../../middleware/auth.js';
import type { AuthenticatedRequest } from '../../types/auth.types.js';
import { sendApiError } from '../../lib/api-error.js';
import {
  ApiCredentialError,
  createApiCredential,
  getApiCredential,
  listApiCredentials,
  listCredentialAuditEvents,
  revokeApiCredential,
  rotateApiCredential,
} from '../../services/api-credential.service.js';

const router = Router();

/**
 * Wallet-scoped API credentials management routes (issue #232).
 *
 * All credential lifecycle routes strictly require a wallet-signed JWT session
 * (`requireAuth` + `requireWalletSessionAuth`). API credentials themselves
 * cannot create, inspect, rotate, or revoke credentials, preventing privilege
 * escalation or self-persistence if an integration key leaks.
 *
 * Responses carry `Cache-Control: no-store` so one-time secrets returned on
 * creation and rotation are never cached by intermediaries.
 */
router.use(requireAuth, requireWalletSessionAuth);
router.use((_req: Request, res: Response, next) => {
  res.setHeader('Cache-Control', 'no-store');
  next();
});

function getAuthenticatedWalletAddress(req: Request): string | null {
  const user = (req as AuthenticatedRequest).user;
  return user?.publicKey ?? user?.walletAddress ?? null;
}

function getParamId(req: Request): string | null {
  const raw = req.params['id'];
  const id = Array.isArray(raw) ? raw[0] : raw;
  if (!id || id.trim().length === 0) return null;
  return id.trim();
}

function getHeaderString(
  value: string | string[] | undefined,
): string | undefined {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value[0];
  return undefined;
}

function getAuditRequestMeta(req: Request): {
  requestId?: string | undefined;
  ip?: string | undefined;
  userAgent?: string | undefined;
} {
  const requestId = getHeaderString(req.headers['x-request-id']);
  const userAgent = getHeaderString(req.headers['user-agent']);
  return {
    ...(requestId ? { requestId } : {}),
    ...(req.ip ? { ip: req.ip } : {}),
    ...(userAgent ? { userAgent } : {}),
  };
}

function handleCredentialError(res: Response, err: unknown): void {
  if (err instanceof ApiCredentialError) {
    sendApiError(res, {
      status: err.status,
      code: err.code,
      message: err.message,
      details: err.details,
    });
    return;
  }
  sendApiError(res, {
    status: 500,
    code: 'INTERNAL_SERVER_ERROR',
    message: 'An unexpected error occurred while managing API credentials.',
  });
}

/**
 * @openapi
 * /v1/credentials:
 *   post:
 *     tags: [Credentials]
 *     summary: Create a wallet-scoped API credential
 *     description: |
 *       Creates a new API credential bound to the authenticated wallet and
 *       configured Stellar network with an explicit allowlist of scopes and a
 *       bounded TTL. The plaintext `secret` is returned **only once** in this
 *       response and is never stored or displayed again.
 *
 *       Requires a wallet-signed JWT session; API credentials cannot create
 *       other API credentials.
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             $ref: '#/components/schemas/CreateApiCredentialRequest'
 *     responses:
 *       201:
 *         description: Credential created with one-time plaintext secret
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/CreateApiCredentialResponse'
 *       400:
 *         $ref: '#/components/responses/BadRequest'
 *       401:
 *         $ref: '#/components/responses/Unauthorized'
 *       403:
 *         $ref: '#/components/responses/Forbidden'
 *       409:
 *         $ref: '#/components/responses/Conflict'
 */
router.post('/', (req: Request, res: Response) => {
  const walletAddress = getAuthenticatedWalletAddress(req);
  if (!walletAddress) {
    sendApiError(res, {
      status: 401,
      code: 'UNAUTHORIZED',
      message: 'Authentication required',
    });
    return;
  }

  const body =
    req.body !== null && typeof req.body === 'object'
      ? (req.body as Record<string, unknown>)
      : {};

  try {
    const created = createApiCredential({
      walletAddress,
      name: body['name'],
      scopes: body['scopes'],
      expiresInSeconds: body['expiresInSeconds'],
      ...getAuditRequestMeta(req),
    });
    res.status(201).json(created);
  } catch (err) {
    handleCredentialError(res, err);
  }
});

/**
 * @openapi
 * /v1/credentials:
 *   get:
 *     tags: [Credentials]
 *     summary: List API credentials owned by the authenticated wallet
 *     description: |
 *       Returns non-secret metadata for API credentials belonging strictly to
 *       the authenticated wallet. Secrets and secret hashes are never returned.
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: includeInactive
 *         schema:
 *           type: boolean
 *           default: true
 *         description: Include revoked and expired credentials when true
 *     responses:
 *       200:
 *         description: Wallet-scoped API credential metadata list
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 credentials:
 *                   type: array
 *                   items:
 *                     $ref: '#/components/schemas/ApiCredential'
 *       401:
 *         $ref: '#/components/responses/Unauthorized'
 *       403:
 *         $ref: '#/components/responses/Forbidden'
 */
router.get('/', (req: Request, res: Response) => {
  const walletAddress = getAuthenticatedWalletAddress(req);
  if (!walletAddress) {
    sendApiError(res, {
      status: 401,
      code: 'UNAUTHORIZED',
      message: 'Authentication required',
    });
    return;
  }

  const includeInactive = req.query['includeInactive'] !== 'false';
  const credentials = listApiCredentials(walletAddress, { includeInactive });
  res.status(200).json({ credentials });
});

/**
 * @openapi
 * /v1/credentials/{id}:
 *   get:
 *     tags: [Credentials]
 *     summary: Get metadata for a single wallet-scoped API credential
 *     description: |
 *       Returns non-secret metadata for the specified credential if owned by
 *       the authenticated wallet. Returns `404` when the credential does not
 *       exist or belongs to a different wallet.
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Credential metadata (no secret)
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 credential:
 *                   $ref: '#/components/schemas/ApiCredential'
 *       401:
 *         $ref: '#/components/responses/Unauthorized'
 *       403:
 *         $ref: '#/components/responses/Forbidden'
 *       404:
 *         $ref: '#/components/responses/NotFound'
 */
router.get('/:id', (req: Request, res: Response) => {
  const walletAddress = getAuthenticatedWalletAddress(req);
  const id = getParamId(req);
  if (!walletAddress) {
    sendApiError(res, {
      status: 401,
      code: 'UNAUTHORIZED',
      message: 'Authentication required',
    });
    return;
  }
  if (!id) {
    sendApiError(res, {
      status: 400,
      code: 'INVALID_CREDENTIAL_ID',
      message: 'Credential ID is required',
    });
    return;
  }

  const credential = getApiCredential(walletAddress, id);
  if (!credential) {
    sendApiError(res, {
      status: 404,
      code: 'CREDENTIAL_NOT_FOUND',
      message: 'API credential not found',
      details: {
        recoveryHint:
          'Verify the credential ID and ensure you are authenticated with the owning wallet.',
      },
    });
    return;
  }

  res.status(200).json({ credential });
});

/**
 * @openapi
 * /v1/credentials/{id}/rotate:
 *   post:
 *     tags: [Credentials]
 *     summary: Rotate a wallet-scoped API credential
 *     description: |
 *       Issues a replacement API credential for the same wallet and returns its
 *       plaintext secret **once**. By default (`gracePeriodSeconds: 0`) the old
 *       credential is revoked immediately; supplying `gracePeriodSeconds > 0`
 *       (up to 7 days) enables a bounded zero-downtime overlap window.
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *     requestBody:
 *       required: false
 *       content:
 *         application/json:
 *           schema:
 *             $ref: '#/components/schemas/RotateApiCredentialRequest'
 *     responses:
 *       200:
 *         description: Credential rotated with one-time replacement secret
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/RotateApiCredentialResponse'
 *       400:
 *         $ref: '#/components/responses/BadRequest'
 *       401:
 *         $ref: '#/components/responses/Unauthorized'
 *       403:
 *         $ref: '#/components/responses/Forbidden'
 *       404:
 *         $ref: '#/components/responses/NotFound'
 *       409:
 *         $ref: '#/components/responses/Conflict'
 */
router.post('/:id/rotate', (req: Request, res: Response) => {
  const walletAddress = getAuthenticatedWalletAddress(req);
  const id = getParamId(req);
  if (!walletAddress) {
    sendApiError(res, {
      status: 401,
      code: 'UNAUTHORIZED',
      message: 'Authentication required',
    });
    return;
  }
  if (!id) {
    sendApiError(res, {
      status: 400,
      code: 'INVALID_CREDENTIAL_ID',
      message: 'Credential ID is required',
    });
    return;
  }

  const body =
    req.body !== null && typeof req.body === 'object'
      ? (req.body as Record<string, unknown>)
      : {};

  try {
    const rotated = rotateApiCredential({
      walletAddress,
      credentialId: id,
      gracePeriodSeconds: body['gracePeriodSeconds'],
      expiresInSeconds: body['expiresInSeconds'],
      scopes: body['scopes'],
      name: body['name'],
      ...getAuditRequestMeta(req),
    });
    res.status(200).json(rotated);
  } catch (err) {
    handleCredentialError(res, err);
  }
});

/**
 * @openapi
 * /v1/credentials/{id}:
 *   delete:
 *     tags: [Credentials]
 *     summary: Revoke a wallet-scoped API credential immediately
 *     description: |
 *       Immediately revokes the specified credential (including terminating any
 *       active rotation grace window). Idempotent for already-revoked credentials
 *       owned by the caller. Returns `404` for credentials owned by another wallet.
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Credential revoked
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 credential:
 *                   $ref: '#/components/schemas/ApiCredential'
 *                 revoked:
 *                   type: boolean
 *                 alreadyRevoked:
 *                   type: boolean
 *       401:
 *         $ref: '#/components/responses/Unauthorized'
 *       403:
 *         $ref: '#/components/responses/Forbidden'
 *       404:
 *         $ref: '#/components/responses/NotFound'
 */
router.delete('/:id', (req: Request, res: Response) => {
  const walletAddress = getAuthenticatedWalletAddress(req);
  const id = getParamId(req);
  if (!walletAddress) {
    sendApiError(res, {
      status: 401,
      code: 'UNAUTHORIZED',
      message: 'Authentication required',
    });
    return;
  }
  if (!id) {
    sendApiError(res, {
      status: 400,
      code: 'INVALID_CREDENTIAL_ID',
      message: 'Credential ID is required',
    });
    return;
  }

  const rawReason =
    req.body !== null &&
    typeof req.body === 'object' &&
    typeof (req.body as Record<string, unknown>)['reason'] === 'string'
      ? ((req.body as Record<string, unknown>)['reason'] as string)
      : undefined;

  try {
    const result = revokeApiCredential({
      walletAddress,
      credentialId: id,
      ...(rawReason !== undefined ? { reason: rawReason } : {}),
      ...getAuditRequestMeta(req),
    });
    res.status(200).json(result);
  } catch (err) {
    handleCredentialError(res, err);
  }
});

/**
 * @openapi
 * /v1/credentials/{id}/audit:
 *   get:
 *     tags: [Credentials]
 *     summary: List audit events for a wallet-scoped API credential
 *     description: |
 *       Returns lifecycle and authentication audit records (creation, rotation,
 *       revocation, auth success, and auth/scope denials) for the specified
 *       credential owned by the authenticated wallet. Secret values are never
 *       recorded or returned.
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *           minimum: 1
 *           maximum: 200
 *           default: 50
 *     responses:
 *       200:
 *         description: Audit events for the credential
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 events:
 *                   type: array
 *                   items:
 *                     $ref: '#/components/schemas/ApiCredentialAuditEvent'
 *       401:
 *         $ref: '#/components/responses/Unauthorized'
 *       403:
 *         $ref: '#/components/responses/Forbidden'
 *       404:
 *         $ref: '#/components/responses/NotFound'
 */
router.get('/:id/audit', (req: Request, res: Response) => {
  const walletAddress = getAuthenticatedWalletAddress(req);
  const id = getParamId(req);
  if (!walletAddress) {
    sendApiError(res, {
      status: 401,
      code: 'UNAUTHORIZED',
      message: 'Authentication required',
    });
    return;
  }
  if (!id) {
    sendApiError(res, {
      status: 400,
      code: 'INVALID_CREDENTIAL_ID',
      message: 'Credential ID is required',
    });
    return;
  }

  const rawLimit = req.query['limit'];
  const parsedLimit =
    typeof rawLimit === 'string' && /^\d+$/.test(rawLimit)
      ? Number.parseInt(rawLimit, 10)
      : undefined;

  try {
    const events = listCredentialAuditEvents(walletAddress, {
      credentialId: id,
      ...(parsedLimit !== undefined ? { limit: parsedLimit } : {}),
    });
    res.status(200).json({ events });
  } catch (err) {
    handleCredentialError(res, err);
  }
});

export default router;
