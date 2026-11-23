import { prisma } from '../../lib/prisma.js';
import type { OrganizationRepository, OrganizationMembershipRecord } from '../middleware/organization.js';

/**
 * Prisma-backed implementation of `OrganizationRepository`.
 *
 * Queries are scoped by `network` so identical organization/slug identifiers on
 * different Stellar networks cannot collide (issue #236).
 */
export class PrismaOrganizationRepository implements OrganizationRepository {
  async findMembershipByWalletAndOrganization(
    walletAddress: string,
    organizationId: string,
    network: string,
  ): Promise<OrganizationMembershipRecord | null> {
    const membership = await prisma.organizationMember.findFirst({
      where: {
        walletAddress,
        organizationId,
        organization: { network },
      },
      include: { organization: true },
    });

    if (!membership) return null;

    return {
      organizationId: membership.organizationId,
      walletAddress: membership.walletAddress,
      role: membership.role as OrganizationMembershipRecord['role'],
      network: membership.organization.network,
    };
  }

  async findOrganizationByIdAndNetwork(
    organizationId: string,
    network: string,
  ): Promise<{ id: string; slug: string; network: string } | null> {
    const organization = await prisma.organization.findFirst({
      where: { id: organizationId, network },
      select: { id: true, slug: true, network: true },
    });

    if (!organization) return null;
    return { id: organization.id, slug: organization.slug, network: organization.network };
  }
}

export const organizationRepository = new PrismaOrganizationRepository();
