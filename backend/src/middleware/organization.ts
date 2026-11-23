import type { Request, Response, NextFunction } from 'express';
import type { AuthenticatedRequest } from '../types/auth.types.js';
import { resolveNetworkScope, requireNetworkScope } from '../lib/network-scope.js';

export type OrganizationRole = 'OWNER' | 'ADMIN' | 'MEMBER';

export const ORGANIZATION_ROLES: OrganizationRole[] = ['OWNER', 'ADMIN', 'MEMBER'];

/**
 * Actions an organization member may attempt on organization-scoped resources.
 * Kept as a stable matrix so authorization decisions can be audited and the
 * matrix published in documentation (issue #234).
 */
export type OrganizationAction =
  | 'organization:read'
  | 'organization:update'
  | 'organization:delete'
  | 'member:invite'
  | 'member:accept'
  | 'member:remove'
  | 'member:list'
  | 'role:change'
  | 'treasury:read'
  | 'network:resolve';

/**
 * Role -> action matrix. A role is authorized for an action when the action is
 * present in its set. More permissive roles implicitly cover less permissive
 * ones by explicit listing (OWNER covers everything; ADMIN covers member-level
 * actions plus administrative actions; MEMBER covers read-only actions).
 *
 * This is the single source of truth for organization-level policy. Route
 * handlers consult it through `authorizeOrganizationAction` rather than making
 * ad hoc role comparisons.
 */
export const ORG_ROLE_ACTION_MATRIX: Record<OrganizationRole, Set<OrganizationAction>> = {
  OWNER: new Set([
    'organization:read',
    'organization:update',
    'organization:delete',
    'member:invite',
    'member:accept',
    'member:remove',
    'member:list',
    'role:change',
    'treasury:read',
    'network:resolve',
  ]),
  ADMIN: new Set([
    'organization:read',
    'organization:update',
    'member:invite',
    'member:accept',
    'member:remove',
    'member:list',
    'role:change',
    'treasury:read',
    'network:resolve',
  ]),
  MEMBER: new Set([
    'organization:read',
    'member:accept',
    'member:list',
    'treasury:read',
    'network:resolve',
  ]),
};

/**
 * Returns `true` when `role` is authorized to perform `action`.
 */
export function isOrganizationActionAuthorized(
  role: OrganizationRole,
  action: OrganizationAction,
): boolean {
  return ORG_ROLE_ACTION_MATRIX[role]?.has(action) ?? false;
}

/**
 * Minimal shape of an organization membership record used for authorization.
 */
export interface OrganizationMembershipRecord {
  organizationId: string;
  walletAddress: string;
  role: OrganizationRole;
  network: string;
}

/**
 * Repository interface used by the organization authorization helpers.
 */
export interface OrganizationRepository {
  findMembershipByWalletAndOrganization(
    walletAddress: string,
    organizationId: string,
    network: string,
  ):
    | Promise<OrganizationMembershipRecord | null>
    | OrganizationMembershipRecord
    | null;
  findOrganizationByIdAndNetwork(
    organizationId: string,
    network: string,
  ):
    | Promise<{ id: string; slug: string; network: string } | null>
    | { id: string; slug: string; network: string } | null;
}

/**
 * Error thrown when a wallet is not a member of the organization it is
 * attempting to act on.
 */
export class OrganizationMembershipError extends Error {
  public readonly statusCode: number;

  constructor(message = 'Wallet is not a member of this organization', statusCode = 403) {
    super(message);
    this.name = 'OrganizationMembershipError';
    this.statusCode = statusCode;
  }
}

/**
 * Resolve the authenticated wallet public key from a request.
 */
export function getAuthenticatedWallet(req: Request): string | null {
  const user = (req as AuthenticatedRequest).user;
  return user?.walletAddress ?? user?.publicKey ?? null;
}

/**
 * Resolve the network scope the request is acting on, requiring it to be
 * unambiguous (issue #236).
 */
export function requireRequestNetwork(req: Request): string {
  return requireNetworkScope(req);
}

/**
 * Assert that the authenticated wallet is a member of the given organization
 * on the request's network, and that it holds one of the allowed roles.
 * Throws `OrganizationMembershipError` (401/403/404) otherwise.
 */
export async function assertWalletMemberOfOrganization(
  req: Request,
  organizationId: string,
  repository: OrganizationRepository,
  allowedRoles: OrganizationRole[] = ORGANIZATION_ROLES,
): Promise<OrganizationMembershipRecord> {
  const wallet = getAuthenticatedWallet(req);

  if (!wallet) {
    throw new OrganizationMembershipError('Authentication required', 401);
  }

  const network = requireRequestNetwork(req);

  const organization = await repository.findOrganizationByIdAndNetwork(organizationId, network);
  if (!organization) {
    throw new OrganizationMembershipError('Organization not found on this network', 404);
  }

  const membership = await repository.findMembershipByWalletAndOrganization(
    wallet,
    organizationId,
    network,
  );

  if (!membership) {
    throw new OrganizationMembershipError('Wallet is not a member of this organization', 403);
  }

  if (!allowedRoles.includes(membership.role)) {
    throw new OrganizationMembershipError(
      `Wallet role "${membership.role}" is not authorized for this action`,
      403,
    );
  }

  return membership;
}

/**
 * Express middleware factory enforcing organization membership and role.
 *
 * The organization identifier is read from `req.params[paramName]` (defaults
 * to `organizationId`). On success the resolved membership is attached to
 * `res.locals.organizationMembership` and the request proceeds.
 *
 * @param repository - Organization repository used to look up memberships.
 * @param allowedRoles - Roles permitted to pass the middleware.
 * @param paramName - Route parameter containing the organization id.
 */
export function requireOrganizationMembership(
  repository: OrganizationRepository,
  allowedRoles: OrganizationRole[] = ORGANIZATION_ROLES,
  paramName = 'organizationId',
) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const organizationId = (req.params as Record<string, string | undefined>)[paramName];

      if (!organizationId) {
        res.status(400).json({ error: 'Missing organization identifier' });
        return;
      }

      const membership = await assertWalletMemberOfOrganization(
        req,
        organizationId,
        repository,
        allowedRoles,
      );
      res.locals.organizationMembership = membership;
      next();
    } catch (error) {
      if (error instanceof OrganizationMembershipError) {
        res.status(error.statusCode).json({ error: error.message });
        return;
      }
      if (error instanceof Error && error.name === 'OrganizationNetworkError') {
        res.status(error.statusCode).json({ error: error.message });
        return;
      }
      next(error);
    }
  };
}

/**
 * Express middleware factory enforcing that the authenticated wallet's
 * organization role is authorized for a specific action, per
 * {@link ORG_ROLE_ACTION_MATRIX}.
 *
 * Requires `requireOrganizationMembership` to have run first (it reads
 * `res.locals.organizationMembership.role`).
 *
 * @param action - The organization-scoped action being authorized.
 */
export function requireOrganizationAction(action: OrganizationAction) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const membership = (res as Response & { locals?: Record<string, unknown> }).locals
      ?.organizationMembership as OrganizationMembershipRecord | undefined;

    if (!membership) {
      res.status(403).json({ error: 'Organization membership not established' });
      return;
    }

    if (!isOrganizationActionAuthorized(membership.role, action)) {
      res.status(403).json({
        error: `Role "${membership.role}" is not authorized to perform "${action}"`,
      });
      return;
    }

    next();
  };
}
