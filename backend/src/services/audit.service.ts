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

export type PolicyDecision = 'allow' | 'deny' | 'error';

export interface PolicyEvaluationAuditRecord {
  actor: string;
  policyId: string;
  decision: PolicyDecision;
  reason: string;
  latencyMs: number;
  outcome: 'success' | 'failure';
  metadata?: Record<string, unknown>;
  requestId?: string;
}

/**
 * Records an audit event for a customer-defined payment policy evaluation.
 *
 * Reuses `recordAuditEvent` so that requestId correlation (explicit or from the
 * ambient request context) is preserved. The recorded action is
 * `payment_policy.evaluate` and the target type is `payment_policy`, with the
 * policy id as the target id. Metadata always carries the policy id, decision,
 * reason, and latency so evaluations are fully auditable.
 */
export async function recordPolicyEvaluationAudit(
  record: PolicyEvaluationAuditRecord,
  transaction?: Prisma.TransactionClient,
): Promise<void> {
  await recordAuditEvent(
    {
      actor: record.actor,
      action: 'payment_policy.evaluate',
      targetType: 'payment_policy',
      targetId: record.policyId,
      outcome: record.outcome,
      metadata: {
        ...(record.metadata ?? {}),
        policyId: record.policyId,
        decision: record.decision,
        reason: record.reason,
        latencyMs: record.latencyMs,
      },
      ...(record.requestId ? { requestId: record.requestId } : {}),
    },
    transaction,
  );
}