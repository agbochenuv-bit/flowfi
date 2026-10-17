import type { Request, Response, NextFunction } from 'express';
import * as crypto from 'crypto';
import * as StellarSdk from '@stellar/stellar-sdk';
import type { AuthenticatedRequest } from '../types/auth.types.js';
import logger from '../logger.js';

const isProduction = process.env.NODE_ENV === 'production';
const rawJwtSecret = process.env.JWT_SECRET;

let JWT_SECRET: string;

if (isProduction) {
  if (!rawJwtSecret) {
    throw new Error('JWT_SECRET environment variable is required in production');
  }
  if (Buffer.from(rawJwtSecret).length < 32) {
    throw new Error('JWT_SECRET must be at least 32 bytes long in production');
  }
  JWT_SECRET = rawJwtSecret;
} else {
  if (!rawJwtSecret) {
    logger.warn('[Auth] JWT_SECRET not set — using random secret; tokens will NOT survive server restart');
    JWT_SECRET = crypto.randomBytes(32).toString('hex');
  } else {
    if (Buffer.from(rawJwtSecret).length < 32) {
      logger.warn('[Auth] JWT_SECRET is less than 32 bytes long; consider using a stronger secret');
    }
    JWT_SECRET = rawJwtSecret;
  }
}

const JWT_EXPIRY_SECONDS = 3600; // 1 hour max per spec

const JWT_ISSUER = process.env.JWT_ISSUER || 'flowfi-api';
const JWT_AUDIENCE = process.env.JWT_AUDIENCE || 'flowfi-api';

const STELLAR_NETWORK =
  process.env.STELLAR_NETWORK === 'mainnet'
    ? StellarSdk.Networks.PUBLIC
    : StellarSdk.Networks.TESTNET;

// ─── Challenge store ────────────────────────────────────────────────────────
//
// Each challenge is a single-use record keyed by its nonce. The record binds
// the challenge to the wallet that requested it, the intended audience, the
// Stellar network passphrase, and an expiration. Verification consumes the
// record atomically (delete-before-verify) so a nonce can never be replayed,
// even under concurrent requests.

export interface WalletChallenge {
  nonce: string;
  publicKey: string;
  audience: string;
  networkPassphrase: string;
  issuedAt: number;
  expiresAt: number;
  consumed: boolean;
}

const CHALLENGE_TTL_MS = 60_000; // 60s to sign

// nonce -> challenge record
const challenges = new Map<string, WalletChallenge>();

const DEFAULT_CHALLENGE_SWEEP_INTERVAL_MS = 5 * 60 * 1000;
let challengeSweepTimer: NodeJS.Timeout | undefined;

function resolveChallengeSweepIntervalMs(): number {
  const raw = process.env.AUTH_CHALLENGE_SWEEP_INTERVAL_MS;
  if (!raw) return DEFAULT_CHALLENGE_SWEEP_INTERVAL_MS;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0
    ? parsed
    : DEFAULT_CHALLENGE_SWEEP_INTERVAL_MS;
}

export function sweepExpiredChallenges(now = Date.now()): number {
  let deleted = 0;
  for (const [nonce, challenge] of challenges.entries()) {
    if (challenge.expiresAt < now || challenge.consumed) {
      challenges.delete(nonce);
      deleted += 1;
    }
  }
  return deleted;
}

export function startChallengeSweep(intervalMs = resolveChallengeSweepIntervalMs()): void {
  if (challengeSweepTimer) return;
  challengeSweepTimer = setInterval(() => {
    sweepExpiredChallenges();
  }, intervalMs);
  challengeSweepTimer.unref?.();
}

export function stopChallengeSweep(): void {
  if (!challengeSweepTimer) return;
  clearInterval(challengeSweepTimer);
  challengeSweepTimer = undefined;
}

startChallengeSweep();

// ─── Minimal JWT (no external dep) ──────────────────────────────────────────

function b64url(buf: Buffer | string): string {
  const b = typeof buf === 'string' ? Buffer.from(buf) : buf;
  return b.toString('base64url');
}

export function signJwt(payload: object): string {
  const header = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const body = b64url(JSON.stringify(payload));
  const sig = crypto
    .createHmac('sha256', JWT_SECRET)
    .update(`${header}.${body}`)
    .digest();
  return `${header}.${body}.${b64url(sig)}`;
}

export function verifyJwt(token: string): { publicKey: string } | null {
  try {
    const [header, body, sig] = token.split('.');
    if (!header || !body || !sig) return null;

    // Compute the expected signature and re-encode it as base64url so we can
    // compare strings directly, rather than decoding the provided signature
    // to bytes first. Decoding base64url to bytes silently discards the
    // unused trailing bits of the final character (a 32-byte digest only
    // uses 4 of the 6 bits in its last base64 character), which means a
    // tampered last character can decode to the *same* bytes as the
    // original and slip past a byte-level comparison undetected.
    const expected = crypto
      .createHmac('sha256', JWT_SECRET)
      .update(`${header}.${body}`)
      .digest();
    const expectedSig = b64url(expected);

    const providedSigBuf = Buffer.from(sig);
    const expectedSigBuf = Buffer.from(expectedSig);

    // Use timingSafeEqual to prevent timing attacks. Lengths are checked
    // first since timingSafeEqual throws on mismatched buffer lengths.
    if (
      providedSigBuf.length !== expectedSigBuf.length ||
      !crypto.timingSafeEqual(providedSigBuf, expectedSigBuf)
    ) {
      return null;
    }

    // Verify expiration
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString());
    if (!payload.exp || payload.exp < Math.floor(Date.now() / 1000)) {
      return null;
    }

    // Verify issuer and audience
    if (payload.iss !== JWT_ISSUER || payload.aud !== JWT_AUDIENCE) {
      return null;
    }

    return { publicKey: payload.sub };
  } catch {
    return null;
  }
}

// ─── Challenge / Verify handlers ────────────────────────────────────────────

function resolveNetworkPassphrase(): string {
  return STELLAR_NETWORK;
}

export function issueChallenge(req: Request, res: Response): void {
  const { publicKey } = req.body as { publicKey?: string };
  if (!publicKey || !StellarSdk.StrKey.isValidEd25519PublicKey(publicKey)) {
    res.status(400).json({ error: 'Invalid publicKey' });
    return;
  }
  const nonce = crypto.randomBytes(32).toString('hex');
  const now = Date.now();
  const expiresAt = now + CHALLENGE_TTL_MS;
  const record: WalletChallenge = {
    nonce,
    publicKey,
    audience: JWT_AUDIENCE,
    networkPassphrase: resolveNetworkPassphrase(),
    issuedAt: now,
    expiresAt,
    consumed: false,
  };
  challenges.set(nonce, record);
  res.json({ nonce, expiresAt });
}

export const __authChallengeTestUtils = {
  challenges,
  startChallengeSweep,
  stopChallengeSweep,
  sweepExpiredChallenges,
  /** Seed a challenge record directly (bypasses HTTP layer). */
  seedChallenge(record: WalletChallenge): void {
    challenges.set(record.nonce, { ...record });
  },
  /** Read a challenge record by nonce, if present. */
  getChallenge(nonce: string): WalletChallenge | undefined {
    const record = challenges.get(nonce);
    return record ? { ...record } : undefined;
  },
  /** Remove all challenge records (test isolation). */
  clearChallenges(): void {
    challenges.clear();
  },
  CHALLENGE_TTL_MS,
};

export function verifyChallenge(req: Request, res: Response): void {
  const { publicKey, signedTransaction } = req.body as {
    publicKey?: string;
    signedTransaction?: string;
  };

  if (!publicKey || !signedTransaction) {
    res.status(400).json({ error: 'publicKey and signedTransaction required' });
    return;
  }

  try {
    const tx = StellarSdk.TransactionBuilder.fromXDR(
      signedTransaction,
      STELLAR_NETWORK,
    ) as StellarSdk.Transaction;

    if (tx.source !== publicKey) {
      res.status(401).json({ error: 'Transaction source does not match publicKey' });
      return;
    }

    // Verify the manage_data op contains a nonce we issued.
    const op = tx.operations[0] as StellarSdk.Operation.ManageData | undefined;
    const nonceHex =
      op && op.type === 'manageData'
        ? Buffer.from(op.value ?? new Uint8Array()).toString('hex')
        : undefined;
    if (!nonceHex) {
      res.status(401).json({ error: 'Invalid challenge nonce in transaction' });
      return;
    }

    // Atomically consume the challenge before doing any signature work. The
    // delete happens synchronously, so a concurrent request carrying the same
    // nonce will observe it as missing and be rejected — no replay window.
    const challenge = challenges.get(nonceHex);
    if (!challenge) {
      res.status(401).json({ error: 'Challenge expired or not found' });
      return;
    }
    if (challenge.consumed) {
      res.status(401).json({ error: 'Challenge already used' });
      return;
    }
    challenge.consumed = true;
    challenges.delete(nonceHex);

    // Bind the challenge to the wallet, audience, and network it was issued
    // for. A challenge issued to wallet A cannot be redeemed by wallet B, nor
    // on a different network or for a different audience.
    if (challenge.publicKey !== publicKey) {
      res.status(401).json({ error: 'Challenge wallet mismatch' });
      return;
    }
    if (challenge.audience !== JWT_AUDIENCE) {
      res.status(401).json({ error: 'Challenge audience mismatch' });
      return;
    }
    if (challenge.networkPassphrase !== resolveNetworkPassphrase()) {
      res.status(401).json({ error: 'Challenge network mismatch' });
      return;
    }
    if (challenge.expiresAt < Date.now()) {
      res.status(401).json({ error: 'Challenge expired or not found' });
      return;
    }

    const keypair = StellarSdk.Keypair.fromPublicKey(publicKey);
    const txHash = tx.hash();
    const valid = tx.signatures.some((s) => {
      try { return keypair.verify(txHash, s.signature); } catch { return false; }
    });

    if (!valid) {
      res.status(401).json({ error: 'Invalid signature' });
      return;
    }

    const now = Math.floor(Date.now() / 1000);
    const token = signJwt({ sub: publicKey, iat: now, exp: now + JWT_EXPIRY_SECONDS, iss: JWT_ISSUER, aud: JWT_AUDIENCE });
    res.json({ token, expiresIn: JWT_EXPIRY_SECONDS });
  } catch (err) {
    logger.error('[Auth] verifyChallenge error:', err);
    res.status(401).json({ error: 'Invalid signed transaction' });
  }
}

// ─── Auth middleware ─────────────────────────────────────────────────────────

export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) {
    res.status(401).json({ error: 'Unauthorized', message: 'Missing Bearer token' });
    return;
  }
  const payload = verifyJwt(header.slice(7));
  if (!payload) {
    res.status(401).json({ error: 'Unauthorized', message: 'Invalid or expired token' });
    return;
  }
  (req as AuthenticatedRequest).user = { publicKey: payload.publicKey };
  next();
}

export function requireAdmin(req: Request, res: Response, next: NextFunction): void {
  requireAuth(req, res, () => {
    const user = (req as AuthenticatedRequest).user;
    const adminKey = process.env.ADMIN_PUBLIC_KEY;
    if (!adminKey || user.publicKey !== adminKey) {
      res.status(403).json({ error: 'Forbidden', message: 'Admin access required' });
      return;
    }
    next();
  });
}

// ─── Wallet ownership / authorization helpers ───────────────────────────────
//
// Routes must never trust client-supplied sender/recipient addresses. These
// helpers resolve ownership from the database and compare it against the
// authenticated wallet on the request.

/**
 * Resolve the wallet that owns a stream, or `null` if the stream does not
 * exist. The lookup is delegated to the caller-supplied resolver so this
 * module stays free of a direct DB dependency (and remains unit-testable).
 */
export type StreamOwnerResolver = (
  streamId: string,
) => Promise<string | null> | string | null;

let streamOwnerResolver: StreamOwnerResolver | undefined;

/**
 * Register the DB-backed resolver used by `resolveStreamOwnership`. Call once
 * at startup (e.g. from the app bootstrap) with a function that queries the
 * streams table.
 */
export function setStreamOwnerResolver(resolver: StreamOwnerResolver): void {
  streamOwnerResolver = resolver;
}

export async function resolveStreamOwnership(
  streamId: string,
): Promise<string | null> {
  if (!streamOwnerResolver) {
    throw new Error(
      'Stream owner resolver not configured; call setStreamOwnerResolver() at startup',
    );
  }
  return streamOwnerResolver(streamId);
}

export class WalletAuthorizationError extends Error {
  status: number;
  constructor(message: string, status = 403) {
    super(message);
    this.name = 'WalletAuthorizationError';
    this.status = status;
  }
}

/**
 * Assert that the authenticated wallet owns the given stream. Throws a
 * `WalletAuthorizationError` (404 if the stream is missing, 403 if it belongs
 * to another wallet) so route handlers can translate it into a response.
 */
export async function assertWalletOwnsStream(
  req: Request,
  streamId: string,
): Promise<void> {
  const user = (req as AuthenticatedRequest).user;
  if (!user?.publicKey) {
    throw new WalletAuthorizationError('Unauthorized', 401);
  }
  const owner = await resolveStreamOwnership(streamId);
  if (owner === null) {
    throw new WalletAuthorizationError('Stream not found', 404);
  }
  if (owner !== user.publicKey) {
    throw new WalletAuthorizationError('Forbidden', 403);
  }
}

/**
 * Express middleware factory enforcing stream ownership for `:id` routes.
 */
export function requireStreamOwnership(
  paramName = 'id',
): (req: Request, res: Response, next: NextFunction) => void {
  return (req, res, next) => {
    const streamId = req.params[paramName];
    if (!streamId) {
      res.status(400).json({ error: 'Bad Request', message: 'Missing stream id' });
      return;
    }
    assertWalletOwnsStream(req, streamId)
      .then(() => next())
      .catch((err: unknown) => {
        if (err instanceof WalletAuthorizationError) {
          res.status(err.status).json({ error: err.message });
          return;
        }
        logger.error('[Auth] requireStreamOwnership error:', err);
        res.status(500).json({ error: 'Internal Server Error' });
      });
  };
}
