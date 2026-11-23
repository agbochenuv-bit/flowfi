import { Router } from 'express';
import type { Request, Response } from 'express';
import {
  requireAuth,
} from '../../middleware/auth.js';
import {
  requireOrganizationMembership,
  requireOrganizationAction,
  OrganizationRole,
  type OrganizationAction,
} from '../../middleware/organization.js';
import {
  createOrganization,
  listMembers,
  inviteMember,
  acceptInvitation,
  removeMember,
  getTreasurySummary,
} from '../../services/organization.service.js';
import { organizationRepository } from '../../repositories/organization.repository.js';
import { requireRequestNetwork } from '../../middleware/organization.js';

const router = Router();

/**
 * Organization routes.
 *
 * Organizations group wallet-linked members under a shared identity for payroll
 * and subscription workflows (issue #233). Every organization-scoped route is
 * bound to a Stellar network so identical identifiers on different networks
 * cannot collide (issue #236), and authorization is driven by the published
 * role/action matrix rather than ad hoc route decisions (issue #234).
 *
 * The operator-facing treasury summary lives under this resource (issue #235).
 */

// All organization routes require an authenticated wallet.
router.use(requireAuth);

/**
 * @openapi
 * /organizations:
 *   post:
 *     tags: [Organizations]
 *     summary: Create an organization
 *     description: >-
 *       Creates a new organization scoped to a Stellar network. The caller
 *       becomes the organization owner (OWNER role). The network is taken from
 *       the `X-Stellar-Network` header or `network` query parameter, falling
 *       back to the server-configured network (issue #236).
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: network
 *         schema: { type: string, enum: [testnet, mainnet] }
 *         description: Stellar network the organization is scoped to
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [name, slug]
 *             properties:
 *               name:
 *                 type: string
 *                 example: Acme Payroll
 *               slug:
 *                 type: string
 *                 example: acme-payroll
 *               network:
 *                 type: string
 *                 description: >-
 *                   Overrides the header-resolved network for this request.
 *                 example: testnet
 *     responses:
 *       201:
 *         description: Organization created
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 id: { type: string }
 *                 slug: { type: string }
 *                 network: { type: string }
 *                 ownerWalletAddress: { type: string }
 *       400:
 *         description: Missing or invalid name/slug/network
 *       401:
 *         description: Unauthenticated
 *       409:
 *         description: Organization slug already exists on this network
 *       429:
 *         description: Too many requests
 */
router.post('/', async (req: Request, res: Response) => {
  const { name, slug, network: bodyNetwork } = req.body as {
    name?: string;
    slug?: string;
    network?: string;
  };

  if (!name || typeof name !== 'string' || name.trim() === '') {
    res.status(400).json({ error: 'name is required' });
    return;
  }
  if (!slug || typeof slug !== 'string' || slug.trim() === '') {
    res.status(400).json({ error: 'slug is required' });
    return;
  }

  const network = bodyNetwork ?? requireRequestNetwork(req);
  const wallet = getAuthenticatedWallet(req);

  try {
    const organization = await createOrganization({
      ownerWalletAddress: wallet,
      name: name.trim(),
      slug: slug.trim().toLowerCase(),
      network,
    });
    res.status(201).json(organization);
    return;
  } catch (err) {
    if (err instanceof Error && err.message.includes('unique')) {
      res.status(409).json({ error: 'Organization slug already exists on this network' });
      return;
    }
    res.status(500).json({ error: 'Failed to create organization' });
  }
});

/**
 * @openapi
 * /organizations/{organizationId}/members:
 *   get:
 *     tags: [Organizations]
 *     summary: List organization members
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - in: path
 *         name: organizationId
 *         required: true
 *         schema: { type: string }
 *       - in: query
 *         name: network
 *         schema: { type: string, enum: [testnet, mainnet] }
 *     responses:
 *       200:
 *         description: Organization members
 *       401:
 *         $ref: '#/components/responses/Unauthorized'
 *       403:
 *         $ref: '#/components/responses/Forbidden'
 *       404:
 *         $ref: '#/components/responses/NotFound'
 */
router.get(
  '/:organizationId/members',
  requireOrganizationMembership(organizationRepository, ['OWNER', 'ADMIN', 'MEMBER']),
  async (req: Request, res: Response) => {
    const { organizationId } = req.params;
    const network = requireRequestNetwork(req);

    try {
      const members = await listMembers({ organizationId, network });
      res.json({ members });
    } catch {
      res.status(404).json({ error: 'Organization not found on this network' });
    }
  },
);

/**
 * @openapi
 * /organizations/{organizationId}/invitations:
 *   post:
 *     tags: [Organizations]
 *     summary: Invite a wallet to join an organization
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - in: path
 *         name: organizationId
 *         required: true
 *         schema: { type: string }
 *       - in: query
 *         name: network
 *         schema: { type: string, enum: [testnet, mainnet] }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [walletAddress]
 *             properties:
 *               walletAddress:
 *                 type: string
 *                 example: GABC123...
 *               role:
 *                 type: string
 *                 enum: [OWNER, ADMIN, MEMBER]
 *                 default: MEMBER
 *     responses:
 *       201:
 *         description: Invitation issued
 *       400:
 *         description: Invitee wallet already a member or has a pending invitation
 *       403:
 *         description: Caller not authorized to invite
 *       404:
 *         description: Organization not found on this network
 */
router.post(
  '/:organizationId/invitations',
  requireOrganizationMembership(organizationRepository, ['OWNER', 'ADMIN']),
  requireOrganizationAction('member:invite'),
  async (req: Request, res: Response) => {
    const { organizationId } = req.params;
    const network = requireRequestNetwork(req);
    const actor = getAuthenticatedWallet(req)!;
    const { walletAddress, role } = req.body as {
      walletAddress?: string;
      role?: OrganizationRole;
    };

    if (!walletAddress) {
      res.status(400).json({ error: 'walletAddress is required' });
      return;
    }

    try {
      const result = await inviteMember({
        organizationId,
        network,
        inviterWalletAddress: actor,
        inviteeWalletAddress: walletAddress,
        role,
      });
      res.status(201).json(result);
    } catch (err) {
      if (err instanceof Error) {
        if (err.message.includes('already a member')) {
          res.status(400).json({ error: err.message });
          return;
        }
        if (err.message.includes('pending invitation')) {
          res.status(400).json({ error: err.message });
          return;
        }
        if (err.message.includes('not found')) {
          res.status(404).json({ error: err.message });
          return;
        }
      }
      res.status(500).json({ error: 'Failed to issue invitation' });
    }
  },
);

/**
 * @openapi
 * /organizations/invitations/{token}/accept:
 *   post:
 *     tags: [Organizations]
 *     summary: Accept an organization invitation
 *     description: >-
 *       Accepts a single-use, time-bound invitation, creating a membership for
 *       the authenticated wallet. Idempotent when a membership already exists.
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - in: path
 *         name: token
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: Invitation accepted
 *       400:
 *         description: Invitation expired, already used, or not for this wallet
 *       401:
 *         $ref: '#/components/responses/Unauthorized'
 */
router.post(
  '/invitations/:token/accept',
  async (req: Request, res: Response) => {
    const { token } = req.params;
    const wallet = getAuthenticatedWallet(req);

    if (!token) {
      res.status(400).json({ error: 'Missing invitation token' });
      return;
    }
    if (!wallet) {
      res.status(401).json({ error: 'Authentication required' });
      return;
    }

    try {
      const result = await acceptInvitation({ token, walletAddress: wallet });
      res.json(result);
    } catch (err) {
      if (err instanceof Error) {
        if (
          err.message.includes('not found') ||
          err.message.includes('expired') ||
          err.message.includes('not addressed') ||
          err.message.includes('cannot be accepted')
        ) {
          res.status(400).json({ error: err.message });
          return;
        }
      }
      res.status(500).json({ error: 'Failed to accept invitation' });
    }
  },
);

/**
 * @openapi
 * /organizations/{organizationId}/members/{walletAddress}:
 *   delete:
 *     tags: [Organizations]
 *     summary: Remove a member from an organization
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - in: path
 *         name: organizationId
 *         required: true
 *         schema: { type: string }
 *       - in: path
 *         name: walletAddress
 *         required: true
 *         schema: { type: string }
 *       - in: query
 *         name: network
 *         schema: { type: string, enum: [testnet, mainnet] }
 *     responses:
 *       200:
 *         description: Member removed
 *       403:
 *         description: Caller not authorized or last-owner guard
 *       404:
 *         description: Organization or member not found on this network
 */
router.delete(
  '/:organizationId/members/:walletAddress',
  requireOrganizationMembership(organizationRepository, ['OWNER', 'ADMIN']),
  requireOrganizationAction('member:remove'),
  async (req: Request, res: Response) => {
    const { organizationId, walletAddress } = req.params;
    const network = requireRequestNetwork(req);
    const actor = getAuthenticatedWallet(req)!;

    try {
      const result = await removeMember({
        organizationId,
        network,
        actorWalletAddress: actor,
        targetWalletAddress: walletAddress,
      });
      res.json(result);
    } catch (err) {
      if (err instanceof Error) {
        if (err.message.includes('not found')) {
          res.status(404).json({ error: err.message });
          return;
        }
        if (
          err.message.includes('not a member') ||
          err.message.includes('not authorized') ||
          err.message.includes('last owner')
        ) {
          res.status(403).json({ error: err.message });
          return;
        }
      }
      res.status(500).json({ error: 'Failed to remove member' });
    }
  },
);

/**
 * @openapi
 * /organizations/{organizationId}/treasury/summary:
 *   get:
 *     tags: [Organizations]
 *     summary: Get treasury balance and liability summary
 *     description: >-
 *       Operator-facing view reconciling configured treasury assets, recorded
 *       fees, and outstanding payment liabilities against the source ledger.
 *       Restricted to organization owners and admins (issue #235).
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - in: path
 *         name: organizationId
 *         required: true
 *         schema: { type: string }
 *       - in: query
 *         name: network
 *         schema: { type: string, enum: [testnet, mainnet] }
 *     responses:
 *       200:
 *         description: Treasury summary
 *       403:
 *         description: Caller not authorized to read the treasury
 *       404:
 *         description: Organization not found on this network
 */
router.get(
  '/:organizationId/treasury/summary',
  requireOrganizationMembership(organizationRepository, ['OWNER', 'ADMIN']),
  requireOrganizationAction('treasury:read'),
  async (req: Request, res: Response) => {
    const { organizationId } = req.params;
    const network = requireRequestNetwork(req);
    const actor = getAuthenticatedWallet(req)!;

    try {
      const summary = await getTreasurySummary({
        organizationId,
        network,
        actorWalletAddress: actor,
      });
      res.json(summary);
    } catch (err) {
      if (err instanceof Error) {
        if (err.message.includes('not found') || err.message.includes('not a member')) {
          res.status(404).json({ error: err.message });
          return;
        }
        if (err.message.includes('restricted')) {
          res.status(403).json({ error: err.message });
          return;
        }
      }
      res.status(500).json({ error: 'Failed to compute treasury summary' });
    }
  },
);

function getAuthenticatedWallet(req: Request): string | null {
  const user = (req as Request & { user?: { walletAddress?: string; publicKey?: string } }).user;
  return user?.walletAddress ?? user?.publicKey ?? null;
}

export default router;
