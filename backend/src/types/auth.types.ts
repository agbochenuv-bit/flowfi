import type { Request } from 'express';

/**
 * User object attached to authenticated requests
 */
export interface AuthUser {
  publicKey: string;
  id?: string;
}

/**
 * Extended Express Request with authenticated user
 */
export interface AuthenticatedRequest extends Request {
  user: AuthUser;
}

/**
 * SEP-10 Challenge Transaction payload
 */
export interface SEP10ChallengePayload {
  transaction: string;
  network_passphrase: string;
}

/**
 * SEP-10 Token payload
 *
 * `kid` is optional to preserve backward compatibility with tokens issued
 * before key-rotation support was introduced (legacy tokens without a
 * key identifier header).
 */
export interface SEP10TokenPayload {
  sub: string; // Stellar public key
  iat: number; // Issued at
  exp: number; // Expiration
  iss: string; // Issuer
  aud: string; // Audience
  kid?: string; // Key identifier (JWT header `kid`) used to sign the token
}

/**
 * Lifecycle status of a JWT signing key.
 *
 * - `active`:   used for signing new tokens and accepted for verification.
 * - `overlap`:  no longer used for signing, but still accepted for
 *               verification during the rotation overlap window.
 * - `retired`:  rejected for verification; must not be used for signing.
 */
export type JwtKeyStatus = 'active' | 'overlap' | 'retired';

/**
 * A single JWT signing/verification key entry.
 *
 * The `secret` is sensitive material and must never be logged or exposed
 * in diagnostics. Only `kid` and `status` are safe to surface.
 */
export interface JwtSigningKey {
  kid: string;
  secret: string;
  status: JwtKeyStatus;
  /** Optional ISO timestamp when the key entered its current status. */
  statusChangedAt?: string;
}

/**
 * Ordered set of signing keys used for issuance and verification.
 *
 * Exactly one key should be `active` for signing; any number of `overlap`
 * keys may remain accepted for verification. `retired` keys are retained
 * only for auditing and must be rejected during verification.
 */
export interface JwtKeySet {
  keys: JwtSigningKey[];
}

/**
 * Safe, non-sensitive view of a signing key for diagnostics/logging.
 */
export interface JwtKeyDiagnostic {
  kid: string;
  status: JwtKeyStatus;
  statusChangedAt?: string;
}