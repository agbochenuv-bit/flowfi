import { Request } from 'express';

/**
 * Authenticated wallet user attached to a request after successful
 * wallet-signature verification.
 *
 * `sessionId` identifies the server-side wallet session that authorized the
 * request. It is an opaque, non-secret identifier (never a signing key or
 * signature) and is used to inventory and revoke sessions.
 */
export interface AuthenticatedUser {
  walletAddress: string;
  sessionId: string;
}

/**
 * Express request augmented with the authenticated wallet user.
 */
export interface AuthenticatedRequest extends Request {
  user?: AuthenticatedUser;
}

/**
 * Public, non-secret description of an active wallet session.
 */
export interface WalletSessionSummary {
  /** Opaque session identifier. */
  sessionId: string;
  /** Wallet address the session was authenticated for. */
  walletAddress: string;
  /** ISO-8601 timestamp of when the session was created. */
  createdAt: string;
  /** ISO-8601 timestamp of the last observed activity, if any. */
  lastSeenAt: string | null;
  /** ISO-8601 timestamp at which the session expires. */
  expiresAt: string;
  /** User agent recorded at session creation, if available. */
  userAgent: string | null;
  /** Whether this session is the one making the current request. */
  current: boolean;
}

/**
 * Response body for the session inventory endpoint.
 */
export interface WalletSessionListResponse {
  sessions: WalletSessionSummary[];
}

/**
 * Response body for a single-session revocation.
 */
export interface WalletSessionRevocationResponse {
  sessionId: string;
  revoked: boolean;
  /** Number of live SSE connections torn down as a result of revocation. */
  closedStreams: number;
}

/**
 * Response body for revoking all sessions for the authenticated wallet.
 */
export interface WalletSessionRevokeAllResponse {
  walletAddress: string;
  /** Session identifiers that were revoked. */
  revokedSessionIds: string[];
  /** Number of live SSE connections torn down as a result of revocation. */
  closedStreams: number;
}

/**
 * Error payload returned when a session is unknown, expired, or already
 * revoked.
 */
export interface WalletSessionErrorResponse {
  error: string;
  code: 'SESSION_NOT_FOUND' | 'SESSION_EXPIRED' | 'SESSION_REVOKED';
}