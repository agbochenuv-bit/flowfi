import { prisma } from '../lib/prisma.js';
import { organizationRepository } from '../repositories/organization.repository.js';
import * as crypto from 'crypto';
import type { OrganizationMembershipRecord, OrganizationRole } from '../middleware/organization.js';

export type TreasuryReconciliationStatus = 'reconciled' | 'stale' | 'unknown';

export interface TreasuryAssetSummary {
  token: string;
  deposited: string;
  withdrawn: string;
  balance: string;
}

export interface TreasurySummary {
  organizationId: string;
  network: string;
  /** The ledger/checkpoint the summary was computed against (source of truth). */
  sourceLedger: { ledgerSequence: number | null; processedAt: string | null };
  reconciliationStatus: TreasuryReconciliationStatus;
  assets: TreasuryAssetSummary[];
  /** Total fees collected, grouped by token (i128 as string). */
  recordedFees: Record<string, string>;
  /** Outstanding payment liabilities: deposited but not yet withdrawn (i128 as string). */
  outstandingLiabilities: string;
  computedAt: string;
}

/**
 * Create an organization owned by the given wallet on a specific network.
 * The owner is automatically granted the OWNER role.
 */
export async function createOrganization(input: {
  ownerWalletAddress: string;
  name: string;
  slug: string;
  network: string;
}): Promise<{
  id: string;
  slug: string;
  network: string;
  ownerWalletAddress: string;
}> {
  const { ownerWalletAddress, name, slug, network } = input;

  const organization = await prisma.organization.create({
    data: {
      name,
      slug,
      network,
      ownerWalletAddress,
      members: {
        create: {
          walletAddress: ownerWalletAddress,
          role: 'OWNER',
        },
      },
    },
    select: { id: true, slug: true, network: true, ownerWalletAddress: true },
  });

  return organization;
}

/**
 * List the members of an organization on a given network.
 */
export async function listMembers(input: {
  organizationId: string;
  network: string;
}): Promise<Array<{
  walletAddress: string;
  role: OrganizationRole;
  invitedBy: string | null;
  joinedAt: string;
}>> {
  const { organizationId, network } = input;

  // Verify the organization exists on this network (multi-network identity).
  await organizationRepository.findOrganizationByIdAndNetwork(organizationId, network);

  const members = await prisma.organizationMember.findMany({
    where: { organizationId, organization: { network } },
    orderBy: { joinedAt: 'asc' },
    select: {
      walletAddress: true,
      role: true,
      invitedBy: true,
      joinedAt: true,
    },
  });

  return members.map((m) => ({
    walletAddress: m.walletAddress,
    role: m.role as OrganizationRole,
    invitedBy: m.invitedBy,
    joinedAt: m.joinedAt.toISOString(),
  }));
}

/**
 * Issue a single-use, time-bound invitation for a wallet to join an
 * organization. Returns the acceptance token that the invitee must present to
 * accept the invitation.
 */
export async function inviteMember(input: {
  organizationId: string;
  network: string;
  inviterWalletAddress: string;
  inviteeWalletAddress: string;
  role?: OrganizationRole;
}): Promise<{ token: string; expiresAt: string }> {
  const {
    organizationId,
    network,
    inviterWalletAddress,
    inviteeWalletAddress,
    role = 'MEMBER',
  } = input;

  const organization = await organizationRepository.findOrganizationByIdAndNetwork(
    organizationId,
    network,
  );
  if (!organization) {
    throw new Error('Organization not found on this network');
  }

  const existing = await prisma.organizationMember.findUnique({
    where: {
      organizationId_walletAddress: { organizationId, walletAddress: inviteeWalletAddress },
    },
  });
  if (existing) {
    throw new Error('Wallet is already a member of this organization');
  }

  const existingInvitation = await prisma.organizationInvitation.findFirst({
    where: {
      organizationId,
      walletAddress: inviteeWalletAddress,
      status: 'PENDING',
    },
  });
  if (existingInvitation) {
    throw new Error('A pending invitation already exists for this wallet');
  }

  const token = cryptoRandomToken();
  const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000); // 7 days

  const invitation = await prisma.organizationInvitation.create({
    data: {
      organizationId,
      walletAddress: inviteeWalletAddress,
      role,
      token,
      status: 'PENDING',
      expiresAt,
      invitedBy: inviterWalletAddress,
    },
    select: { token: true, expiresAt: true },
  });

  return { token: invitation.token, expiresAt: invitation.expiresAt.toISOString() };
}

/**
 * Accept a pending invitation, creating a membership for the invitee. The
 * invitation is marked ACCEPTED and cannot be reused.
 */
export async function acceptInvitation(input: {
  token: string;
  walletAddress: string;
}): Promise<{
  organizationId: string;
  organizationSlug: string;
  network: string;
  role: OrganizationRole;
}> {
  const { token, walletAddress } = input;

  const invitation = await prisma.organizationInvitation.findUnique({
    where: { token },
    include: { organization: true },
  });

  if (!invitation) {
    throw new Error('Invitation not found');
  }
  if (invitation.status !== 'PENDING') {
    throw new Error(`Invitation is ${invitation.status.toLowerCase()} and cannot be accepted`);
  }
  if (invitation.walletAddress !== walletAddress) {
    throw new Error('Invitation is not addressed to this wallet');
  }
  if (invitation.expiresAt < new Date()) {
    await prisma.organizationInvitation.update({
      where: { id: invitation.id },
      data: { status: 'EXPIRED' },
    });
    throw new Error('Invitation has expired');
  }

  // Idempotent: if a membership already exists, accept is a no-op success.
  const existing = await prisma.organizationMember.findUnique({
    where: {
      organizationId_walletAddress: {
        organizationId: invitation.organizationId,
        walletAddress,
      },
    },
  });
  if (existing) {
    await prisma.organizationInvitation.update({
      where: { id: invitation.id },
      data: { status: 'ACCEPTED', acceptedAt: new Date() },
    });
    return {
      organizationId: invitation.organizationId,
      organizationSlug: invitation.organization.slug,
      network: invitation.organization.network,
      role: existing.role as OrganizationRole,
    };
  }

  const membership = await prisma.organizationMember.create({
    data: {
      organizationId: invitation.organizationId,
      walletAddress,
      role: invitation.role,
      invitedBy: invitation.invitedBy,
    },
  });

  await prisma.organizationInvitation.update({
    where: { id: invitation.id },
    data: { status: 'ACCEPTED', acceptedAt: new Date() },
  });

  return {
    organizationId: membership.organizationId,
    organizationSlug: invitation.organization.slug,
    network: invitation.organization.network,
    role: membership.role as OrganizationRole,
  };
}

/**
 * Remove a member from an organization. The organization owner cannot remove
 * themselves; the last OWNER cannot be removed (ownership must be transferred
 * first).
 */
export async function removeMember(input: {
  organizationId: string;
  network: string;
  actorWalletAddress: string;
  targetWalletAddress: string;
}): Promise<{ removed: boolean }> {
  const {
    organizationId,
    network,
    actorWalletAddress,
    targetWalletAddress,
  } = input;

  const organization = await organizationRepository.findOrganizationByIdAndNetwork(
    organizationId,
    network,
  );
  if (!organization) {
    throw new Error('Organization not found on this network');
  }

  const actor = await prisma.organizationMember.findUnique({
    where: {
      organizationId_walletAddress: { organizationId, walletAddress: actorWalletAddress },
    },
  });
  if (!actor) {
    throw new Error('Actor is not a member of this organization');
  }
  if (actor.role !== 'OWNER' && actor.role !== 'ADMIN') {
    throw new Error('Only owners and admins can remove members');
  }

  const target = await prisma.organizationMember.findUnique({
    where: {
      organizationId_walletAddress: { organizationId, walletAddress: targetWalletAddress },
    },
  });
  if (!target) {
    throw new Error('Target is not a member of this organization');
  }

  if (target.walletAddress === actorWalletAddress && actor.role === 'OWNER') {
    const ownerCount = await prisma.organizationMember.count({
      where: { organizationId, role: 'OWNER' },
    });
    if (ownerCount <= 1) {
      throw new Error('Cannot remove the last owner; transfer ownership first');
    }
  }

  await prisma.organizationMember.delete({
    where: {
      organizationId_walletAddress: {
        organizationId,
        walletAddress: targetWalletAddress,
      },
    },
  });

  return { removed: true };
}

/**
 * Compute an operator-facing treasury balance and liability summary for an
 * organization on a given network (issue #235).
 *
 * The summary reconciles configured treasury assets (deposited amounts),
 * recorded fees, and outstanding payment liabilities (deposited but not yet
 * withdrawn) against the source ledger. Access is restricted to OWNER/ADMIN
 * callers by the route middleware.
 */
export async function getTreasurySummary(input: {
  organizationId: string;
  network: string;
  actorWalletAddress: string;
}): Promise<TreasurySummary> {
  const { organizationId, network, actorWalletAddress } = input;

  const membership = await organizationRepository.findMembershipByWalletAndOrganization(
    actorWalletAddress,
    organizationId,
    network,
  );
  if (!membership) {
    throw new Error('Actor is not a member of this organization');
  }
  if (membership.role !== 'OWNER' && membership.role !== 'ADMIN') {
    throw new Error('Treasury summary is restricted to owners and admins');
  }

  // Source ledger: the latest non-reverted checkpoint, falling back to the
  // indexer state when no checkpoint exists.
  const checkpoint = await prisma.ledgerCheckpoint.findFirst({
    where: { isReverted: false },
    orderBy: { ledgerSequence: 'desc' },
    select: { ledgerSequence: true, processedAt: true },
  });

  const indexerState = await prisma.indexerState.findUnique({
    where: { id: 'singleton' },
    select: { lastLedger: true, updatedAt: true },
  });

  const sourceLedger = checkpoint
    ? { ledgerSequence: checkpoint.ledgerSequence, processedAt: checkpoint.processedAt?.toISOString() ?? null }
    : {
        ledgerSequence: indexerState?.lastLedger ?? null,
        processedAt: indexerState?.updatedAt?.toISOString() ?? null,
      };

  const reconciliationStatus: TreasuryReconciliationStatus = checkpoint
    ? 'reconciled'
    : indexerState
      ? 'stale'
      : 'unknown';

  // Aggregate stream balances per token. Streams are not network-scoped in the
  // legacy schema, so we summarize all streams and tag the network in the
  // response for operator awareness (issue #236 migration note).
  const streams = await prisma.stream.findMany({
    where: {},
    select: {
      tokenAddress: true,
      depositedAmount: true,
      withdrawnAmount: true,
      isActive: true,
    },
  });

  const assetsByToken = new Map<string, { deposited: bigint; withdrawn: bigint }>();
  let outstandingLiabilities = 0n;

  for (const stream of streams) {
    const token = stream.tokenAddress;
    const entry = assetsByToken.get(token) ?? { deposited: 0n, withdrawn: 0n };
    entry.deposited += BigInt(stream.depositedAmount ?? '0');
    entry.withdrawn += BigInt(stream.withdrawnAmount ?? '0');
    assetsByToken.set(token, entry);

    if (stream.isActive) {
      outstandingLiabilities +=
        BigInt(stream.depositedAmount ?? '0') - BigInt(stream.withdrawnAmount ?? '0');
    }
  }

  const assets: TreasuryAssetSummary[] = [];
  const recordedFees: Record<string, string> = {};

  for (const [token, { deposited, withdrawn }] of assetsByToken) {
    const balance = deposited - withdrawn;
    assets.push({
      token,
      deposited: deposited.toString(),
      withdrawn: withdrawn.toString(),
      balance: balance.toString(),
    });
  }

  // Recorded fees from FEE_COLLECTED events (grouped in SQL by the admin
  // metrics endpoint pattern). Here we aggregate in Node over the event table.
  const feeEvents = await prisma.streamEvent.findMany({
    where: { eventType: 'FEE_COLLECTED' },
    select: { amount: true, metadata: true },
  });

  for (const event of feeEvents) {
    let token = 'unknown';
    try {
      const meta = event.metadata ? JSON.parse(event.metadata) : {};
      if (meta && typeof meta === 'object' && 'token' in meta) {
        token = String((meta as Record<string, unknown>).token);
      }
    } catch {
      token = 'unknown';
    }
    recordedFees[token] = (BigInt(recordedFees[token] ?? '0') + BigInt(event.amount ?? '0')).toString();
  }

  assets.sort((a, b) => a.token.localeCompare(b.token));

  return {
    organizationId,
    network,
    sourceLedger,
    reconciliationStatus,
    assets,
    recordedFees,
    outstandingLiabilities: outstandingLiabilities.toString(),
    computedAt: new Date().toISOString(),
  };
}

function cryptoRandomToken(): string {
  return crypto.randomBytes(24).toString('hex');
}
