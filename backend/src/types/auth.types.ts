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
 */
export interface SEP10TokenPayload {
  sub: string; // Stellar public key
  iat: number; // Issued at
  exp: number; // Expiration
  iss: string; // Issuer
  aud: string; // Audience
}

/**
 * Persisted wallet authentication challenge.
 *
 * Each challenge is single-use and bound to the wallet, intended audience,
 * network, and expiration window. A challenge may only be exchanged once
 * (see `consumed`) and only by the wallet it was issued to, on the network
 * and for the audience it was issued for.
 */
export interface WalletChallenge {
  /** Unique, cryptographically random nonce identifying the challenge. */
  nonce: string;
  /** Stellar public key (G...) the challenge was issued to. */
  publicKey: string;
  /** Intended audience (e.g. relying application / origin) of the challenge. */
  audience: string;
  /** Stellar network passphrase the challenge is valid on. */
  network: string;
  /** Unix epoch milliseconds when the challenge was issued. */
  issuedAt: number;
  /** Unix epoch milliseconds after which the challenge is no longer valid. */
  expiresAt: number;
  /** Whether the challenge has already been exchanged for a token. */
  consumed: boolean;
}

/**
 * Authorization scopes describing which authenticated wallet may read or
 * mutate a given resource. Ownership is enforced at the route/service
 * boundary rather than trusting client-supplied addresses.
 */
export type AuthScope =
  | 'user:read'
  | 'user:write'
  | 'stream:read'
  | 'stream:write'
  | 'admin:read'
  | 'admin:write'
  | 'webhook:read'
  | 'webhook:write';

/**
 * Resource kinds that can be owned by a wallet.
 */
export type OwnedResourceType = 'user' | 'stream' | 'admin' | 'webhook';

/**
 * Ownership descriptor used by authorization helpers to determine whether
 * the authenticated wallet may act on a resource.
 */
export interface ResourceOwnership {
  /** Type of the resource being accessed. */
  resourceType: OwnedResourceType;
  /** Identifier of the resource. */
  resourceId: string;
  /** Stellar public key of the wallet that owns the resource. */
  ownerPublicKey: string;
  /** Whether the resource is intentionally public (readable by anyone). */
  isPublic?: boolean;
}

/**
 * Result of an authorization check performed by ownership helpers.
 */
export interface AuthorizationResult {
  allowed: boolean;
  /** Machine-readable reason when access is denied. */
  reason?: 'unauthenticated' | 'not_owner' | 'insufficient_scope' | 'not_found';
}