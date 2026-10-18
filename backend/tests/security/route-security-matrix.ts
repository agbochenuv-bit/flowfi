/**
 * Route-Level Security Authorization Matrix
 *
 * Provides a reusable, declarative security test harness that tests API endpoints
 * against standard caller identity roles:
 * - Anonymous (unauthenticated caller)
 * - Owner (creator/resource owner)
 * - Counterparty (intended recipient or counter-signer)
 * - Unrelated Wallet (authenticated, but neither owner nor counterparty)
 * - Admin (elevated privileges / platform operator)
 */

export type IdentityRole = 'anonymous' | 'owner' | 'counterparty' | 'unrelated' | 'admin';

export interface TestCallerIdentity {
  role: IdentityRole;
  address?: string;
  token?: string;
  isAdmin?: boolean;
}

export const IDENTITIES: Record<IdentityRole, TestCallerIdentity> = {
  anonymous: {
    role: 'anonymous',
  },
  owner: {
    role: 'owner',
    address: 'GBEVJL4RM4IIUHWMB6N2X2LDYV5XEXR7GHCJ2GZCHP3FHLREX3W2TIIY',
    token: 'mock-jwt-owner',
    isAdmin: false,
  },
  counterparty: {
    role: 'counterparty',
    address: 'GC2B26ZCT46R56743A5W3H2PBX4X5I3J5J3H2PBX4X5I3J5J3H2PBX4X',
    token: 'mock-jwt-counterparty',
    isAdmin: false,
  },
  unrelated: {
    role: 'unrelated',
    address: 'GDUKMGUGDZQK6YHYA5Z6TU2DY4OZRN2R5HG6546PQM2SDIR5225EWG3G',
    token: 'mock-jwt-unrelated',
    isAdmin: false,
  },
  admin: {
    role: 'admin',
    address: 'GAADMIN7777777777777777777777777777777777777777777777777',
    token: 'mock-jwt-admin',
    isAdmin: true,
  },
};

export interface RouteMatrixRule {
  domain: 'stream' | 'user' | 'webhook' | 'export' | 'replay';
  path: string;
  method: 'GET' | 'POST' | 'PUT' | 'DELETE';
  expectedStatuses: Record<IdentityRole, number>;
}

export const ROUTE_SECURITY_MATRIX: RouteMatrixRule[] = [
  // Streams API
  {
    domain: 'stream',
    path: '/v1/streams',
    method: 'GET',
    expectedStatuses: {
      anonymous: 200,
      owner: 200,
      counterparty: 200,
      unrelated: 200,
      admin: 200,
    },
  },
  {
    domain: 'stream',
    path: '/v1/streams/:id/cancel',
    method: 'POST',
    expectedStatuses: {
      anonymous: 401,
      owner: 200,
      counterparty: 403,
      unrelated: 403,
      admin: 200,
    },
  },
  {
    domain: 'stream',
    path: '/v1/streams/:id/withdraw',
    method: 'POST',
    expectedStatuses: {
      anonymous: 401,
      owner: 403,
      counterparty: 200,
      unrelated: 403,
      admin: 200,
    },
  },

  // User API
  {
    domain: 'user',
    path: '/v1/users/:address/summary',
    method: 'GET',
    expectedStatuses: {
      anonymous: 401,
      owner: 200,
      counterparty: 403,
      unrelated: 403,
      admin: 200,
    },
  },

  // Webhook API
  {
    domain: 'webhook',
    path: '/v1/webhooks/subscriptions',
    method: 'POST',
    expectedStatuses: {
      anonymous: 401,
      owner: 201,
      counterparty: 201,
      unrelated: 201,
      admin: 201,
    },
  },
  {
    domain: 'webhook',
    path: '/v1/webhooks/subscriptions/:id',
    method: 'DELETE',
    expectedStatuses: {
      anonymous: 401,
      owner: 200,
      counterparty: 403,
      unrelated: 403,
      admin: 200,
    },
  },

  // Export API
  {
    domain: 'export',
    path: '/v1/streams/export/csv',
    method: 'GET',
    expectedStatuses: {
      anonymous: 401,
      owner: 200,
      counterparty: 200,
      unrelated: 200,
      admin: 200,
    },
  },

  // Replay & Admin Operations API
  {
    domain: 'replay',
    path: '/v1/admin/indexer/replay',
    method: 'POST',
    expectedStatuses: {
      anonymous: 401,
      owner: 403,
      counterparty: 403,
      unrelated: 403,
      admin: 200,
    },
  },
  {
    domain: 'replay',
    path: '/v1/admin/indexer/reset',
    method: 'POST',
    expectedStatuses: {
      anonymous: 401,
      owner: 403,
      counterparty: 403,
      unrelated: 403,
      admin: 200,
    },
  },
];

/**
 * Validates whether a caller identity is permitted for a specific route rule.
 */
export function evaluateAccess(
  rule: RouteMatrixRule,
  identity: TestCallerIdentity
): { allowed: boolean; expectedStatus: number } {
  const status = rule.expectedStatuses[identity.role];
  const allowed = status >= 200 && status < 300;
  return { allowed, expectedStatus: status };
}
