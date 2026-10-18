import { randomUUID } from 'node:crypto';
import { prisma } from '../lib/prisma.js';
import { requestContext } from '../logger.js';
import type { Prisma } from '../generated/prisma/index.js';

export interface AuditRecord {
  actor: string;
  action: string;
  targetType: string;
  targetId: string;
  outcome: 'success' | 'failure';
  before?: Record<string, unknown>;
  after?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
  requestId?: string;
}

export async function recordAuditEvent(
  record: AuditRecord,
  transaction?: Prisma.TransactionClient,
): Promise<void> {
  const client = transaction ?? prisma;
  await client.auditEvent.create({
    data: {
      id: randomUUID(),
      actor: record.actor,
      requestId: record.requestId ?? requestContext.getStore()?.requestId ?? null,
      action: record.action,
      targetType: record.targetType,
      targetId: record.targetId,
      outcome: record.outcome,
      ...(record.before ? { before: record.before as Prisma.InputJsonValue } : {}),
      ...(record.after ? { after: record.after as Prisma.InputJsonValue } : {}),
      ...(record.metadata ? { metadata: record.metadata as Prisma.InputJsonValue } : {}),
    },
  });
}