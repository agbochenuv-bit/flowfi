import { describe, it, expect } from 'vitest';
import {
  ROUTE_SECURITY_MATRIX,
  IDENTITIES,
  evaluateAccess,
  IdentityRole,
} from './route-security-matrix.js';

describe('Route-Level Security Authorization Matrix Tests', () => {
  const roles: IdentityRole[] = ['anonymous', 'owner', 'counterparty', 'unrelated', 'admin'];

  it('covers all critical domains: stream, user, webhook, export, and replay', () => {
    const domains = new Set(ROUTE_SECURITY_MATRIX.map((r) => r.domain));
    expect(domains.has('stream')).toBe(true);
    expect(domains.has('user')).toBe(true);
    expect(domains.has('webhook')).toBe(true);
    expect(domains.has('export')).toBe(true);
    expect(domains.has('replay')).toBe(true);
  });

  describe('Anonymous Identity Enforcement', () => {
    it('blocks anonymous access on protected routes with HTTP 401', () => {
      const protectedRules = ROUTE_SECURITY_MATRIX.filter(
        (r) => r.path !== '/v1/streams' || r.method !== 'GET'
      );

      for (const rule of protectedRules) {
        const { allowed, expectedStatus } = evaluateAccess(rule, IDENTITIES.anonymous);
        expect(allowed).toBe(false);
        expect(expectedStatus).toBe(401);
      }
    });
  });

  describe('Unrelated Wallet Isolation', () => {
    it('prevents unrelated wallets from managing resources owned by other users', () => {
      const privateOperations = ROUTE_SECURITY_MATRIX.filter((r) =>
        ['/v1/streams/:id/cancel', '/v1/webhooks/subscriptions/:id', '/v1/users/:address/summary'].includes(
          r.path
        )
      );

      for (const rule of privateOperations) {
        const { allowed, expectedStatus } = evaluateAccess(rule, IDENTITIES.unrelated);
        expect(allowed).toBe(false);
        expect(expectedStatus).toBe(403);
      }
    });
  });

  describe('Admin Privileged Routes', () => {
    it('restricts replay and indexer reset APIs strictly to admin identity', () => {
      const adminRules = ROUTE_SECURITY_MATRIX.filter((r) => r.domain === 'replay');

      for (const rule of adminRules) {
        // Non-admin roles must be denied
        for (const role of ['anonymous', 'owner', 'counterparty', 'unrelated'] as IdentityRole[]) {
          const outcome = evaluateAccess(rule, IDENTITIES[role]);
          expect(outcome.allowed).toBe(false);
          expect([401, 403]).toContain(outcome.expectedStatus);
        }

        // Admin must be permitted
        const adminOutcome = evaluateAccess(rule, IDENTITIES.admin);
        expect(adminOutcome.allowed).toBe(true);
        expect(adminOutcome.expectedStatus).toBe(200);
      }
    });
  });

  describe('Counterparty Permissions', () => {
    it('allows counterparty (recipient) to withdraw from stream but prevents cancellation', () => {
      const withdrawRule = ROUTE_SECURITY_MATRIX.find((r) => r.path === '/v1/streams/:id/withdraw')!;
      const cancelRule = ROUTE_SECURITY_MATRIX.find((r) => r.path === '/v1/streams/:id/cancel')!;

      const withdrawEval = evaluateAccess(withdrawRule, IDENTITIES.counterparty);
      expect(withdrawEval.allowed).toBe(true);
      expect(withdrawEval.expectedStatus).toBe(200);

      const cancelEval = evaluateAccess(cancelRule, IDENTITIES.counterparty);
      expect(cancelEval.allowed).toBe(false);
      expect(cancelEval.expectedStatus).toBe(403);
    });
  });
});
