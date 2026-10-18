/**
 * Operational alerting.
 *
 * Critical indexer failures are written to `IndexerDeadLetterEvent`, but a table
 * nobody polls is not an alert. This module pushes an urgent, human-readable
 * message to a chat webhook (`ALERT_WEBHOOK_URL`) the moment an event is
 * dead-lettered, so on-call engineers find out before users report missing
 * stream data.
 *
 * The payload is shaped for the receiver at `ALERT_WEBHOOK_URL`:
 *  - Slack incoming webhooks -> Block Kit (`blocks`),
 *  - Discord webhooks -> rich embeds (`embeds`),
 *  - anything else -> a generic JSON envelope.
 *
 * Every exported sender is failure-proof: a webhook outage, a bad URL or a slow
 * endpoint must never throw into (and therefore crash) the indexer loop.
 */
import logger from '../logger.js';

export type AlertWebhookKind = 'slack' | 'discord' | 'generic';

export interface DeadLetterAlert {
  eventId: string;
  eventType: string;
  ledgerSequence: number;
  txHash: string;
  errorMessage: string;
  /** Full stack trace from the failing handler, when one was captured. */
  errorStack?: string | undefined;
  /** Dead-letter attempt counter (1 on first failure, incrementing on retries). */
  attempts?: number | undefined;
}

/** Configured alert webhook, or `undefined` when alerting is disabled. */
export function getAlertWebhookUrl(): string | undefined {
  const url = process.env.ALERT_WEBHOOK_URL?.trim();
  return url ? url : undefined;
}

/**
 * Deep link an on-call engineer can click to see (and replay/discard) the
 * quarantined event in the admin dead-letter console.
 */
export function buildTriageUrl(eventId: string): string {
  const base = (
    process.env.ADMIN_DASHBOARD_URL ??
    process.env.FRONTEND_URL ??
    'https://app.flowfi.xyz'
  ).replace(/\/+$/, '');

  return `${base}/admin/indexer/dead-letter?eventId=${encodeURIComponent(eventId)}`;
}

/** Classify a webhook URL so the payload matches the chat provider. */
export function detectWebhookKind(url: string): AlertWebhookKind {
  if (/hooks\.slack\.com/i.test(url)) return 'slack';
  if (/discord(app)?\.com\/api\/webhooks/i.test(url)) return 'discord';
  return 'generic';
}

function truncate(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

/** Build the provider-specific JSON body for a dead-letter alert. */
export function buildDeadLetterPayload(
  kind: AlertWebhookKind,
  alert: DeadLetterAlert,
): Record<string, unknown> {
  const triageUrl = buildTriageUrl(alert.eventId);
  const attempts = alert.attempts ?? 1;
  const errorText = truncate(alert.errorMessage, 900);
  const stack = alert.errorStack ? truncate(alert.errorStack, 1200) : undefined;

  if (kind === 'slack') {
    return {
      text: `🚨 Indexer dead-letter: ${alert.eventType} at ledger ${alert.ledgerSequence}`,
      blocks: [
        {
          type: 'header',
          text: { type: 'plain_text', text: '🚨 Indexer dead-letter event', emoji: true },
        },
        {
          type: 'section',
          fields: [
            { type: 'mrkdwn', text: `*Event type:*\n${alert.eventType}` },
            { type: 'mrkdwn', text: `*Ledger:*\n${alert.ledgerSequence}` },
            { type: 'mrkdwn', text: `*Tx hash:*\n\`${alert.txHash}\`` },
            { type: 'mrkdwn', text: `*Attempts:*\n${attempts}` },
          ],
        },
        {
          type: 'section',
          text: { type: 'mrkdwn', text: `*Error:*\n\`\`\`${errorText}\`\`\`` },
        },
        {
          type: 'actions',
          elements: [
            {
              type: 'button',
              text: { type: 'plain_text', text: 'Triage in admin' },
              url: triageUrl,
            },
          ],
        },
      ],
    };
  }

  if (kind === 'discord') {
    return {
      content: `🚨 **Indexer dead-letter** — ${alert.eventType} at ledger ${alert.ledgerSequence}`,
      embeds: [
        {
          title: `Dead-lettered event: ${alert.eventType}`,
          url: triageUrl,
          color: 0xe74c3c,
          timestamp: new Date().toISOString(),
          fields: [
            { name: 'Ledger', value: String(alert.ledgerSequence), inline: true },
            { name: 'Attempts', value: String(attempts), inline: true },
            { name: 'Event id', value: `\`${truncate(alert.eventId, 100)}\``, inline: false },
            { name: 'Tx hash', value: `\`${truncate(alert.txHash, 100)}\``, inline: false },
            { name: 'Error', value: `\`\`\`${errorText}\`\`\``, inline: false },
            ...(stack ? [{ name: 'Stack', value: `\`\`\`${stack}\`\`\``, inline: false }] : []),
          ],
        },
      ],
    };
  }

  return {
    text: `🚨 Indexer dead-letter: ${alert.eventType} at ledger ${alert.ledgerSequence}`,
    eventId: alert.eventId,
    eventType: alert.eventType,
    ledgerSequence: alert.ledgerSequence,
    txHash: alert.txHash,
    errorMessage: alert.errorMessage,
    errorStack: alert.errorStack,
    attempts,
    triageUrl,
    timestamp: new Date().toISOString(),
  };
}

/**
 * POST the alert to `ALERT_WEBHOOK_URL`.
 *
 * @returns `true` when the webhook accepted the message. Never throws: alerting
 *   is best-effort and must not take down the caller (the indexer loop).
 */
export async function sendDeadLetterAlert(alert: DeadLetterAlert): Promise<boolean> {
  const url = getAlertWebhookUrl();
  if (!url) {
    return false;
  }

  try {
    const payload = buildDeadLetterPayload(detectWebhookKind(url), alert);
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(10_000),
    });

    if (!response.ok) {
      logger.warn(
        `[Alert] Dead-letter webhook returned HTTP ${response.status} for event ${alert.eventId}`,
      );
      return false;
    }

    return true;
  } catch (err) {
    // Swallow: a failed alert must never crash the indexer loop, and the
    // dead-letter row itself remains the source of truth for triage.
    logger.error(`[Alert] Failed to deliver dead-letter webhook for event ${alert.eventId}:`, err);
    return false;
  }
}

// ---------------------------------------------------------------------------
// Operational alerts: dead-letter growth, indexer lag, repeated RPC failure.
// ---------------------------------------------------------------------------

/** The operational conditions this module can raise. */
export type OperationalAlertKind = 'dead_letter_growth' | 'indexer_lag' | 'rpc_failure';

/** Snapshot of the metrics the evaluator inspects. */
export interface OperationalAlertMetrics {
  /** Number of dead-lettered events currently quarantined. */
  deadLetterCount: number;
  /** Seconds since the indexer last advanced its cursor. */
  indexerLagSeconds: number;
  /** Consecutive RPC failures observed since the last success. */
  rpcFailureCount: number;
}

/** Per-condition state persisted between evaluations (dedupe + recovery). */
export interface OperationalAlertState {
  kind: OperationalAlertKind;
  /** Stable dedupe key for the condition. */
  dedupeKey: string;
  /** Whether the condition is currently firing. */
  firing: boolean;
  /** Epoch ms of the last notification sent for this condition. */
  lastNotifiedAt: number | null;
  /** Epoch ms when the condition first crossed its threshold. */
  firingSince: number | null;
}

/** Thresholds and cooldown for operational alerts. */
export interface OperationalAlertThresholds {
  deadLetterCount: number;
  indexerLagSeconds: number;
  rpcFailureCount: number;
  /** Minimum ms between repeat notifications for a still-firing condition. */
  cooldownMs: number;
}

export const DEFAULT_OPERATIONAL_ALERT_THRESHOLDS: OperationalAlertThresholds = {
  deadLetterCount: 25,
  indexerLagSeconds: 300,
  rpcFailureCount: 5,
  cooldownMs: 15 * 60 * 1000,
};

/** A notification the evaluator decided to emit. */
export interface OperationalAlertNotification {
  kind: OperationalAlertKind;
  dedupeKey: string;
  /** `firing` on threshold crossing, `recovery` when the condition clears. */
  transition: 'firing' | 'recovery';
  /** Human-readable, redacted summary (counts/durations only). */
  message: string;
  /** Structured, redacted details safe to forward to a chat provider. */
  details: Record<string, string | number>;
  timestamp: string;
}

/** Result of one evaluation pass. */
export interface OperationalAlertEvaluation {
  /** Notifications that should be delivered (already deduped). */
  notifications: OperationalAlertNotification[];
  /** Updated state to persist. */
  state: OperationalAlertState[];
}

/** Stable dedupe key for a condition. */
export function buildOperationalDedupeKey(kind: OperationalAlertKind): string {
  return `operational:${kind}`;
}

function readThresholds(
  overrides?: Partial<OperationalAlertThresholds>,
): OperationalAlertThresholds {
  return { ...DEFAULT_OPERATIONAL_ALERT_THRESHOLDS, ...(overrides ?? {}) };
}

function describeCondition(
  kind: OperationalAlertKind,
  metrics: OperationalAlertMetrics,
  thresholds: OperationalAlertThresholds,
): { message: string; details: Record<string, string | number> } {
  if (kind === 'dead_letter_growth') {
    return {
      message: `Dead-letter queue grew to ${metrics.deadLetterCount} events (threshold ${thresholds.deadLetterCount}).`,
      details: {
        deadLetterCount: metrics.deadLetterCount,
        threshold: thresholds.deadLetterCount,
      },
    };
  }
  if (kind === 'indexer_lag') {
    return {
      message: `Indexer lag is ${metrics.indexerLagSeconds}s (threshold ${thresholds.indexerLagSeconds}s).`,
      details: {
        indexerLagSeconds: metrics.indexerLagSeconds,
        threshold: thresholds.indexerLagSeconds,
      },
    };
  }
  return {
    message: `RPC failure count reached ${metrics.rpcFailureCount} (threshold ${thresholds.rpcFailureCount}).`,
    details: {
      rpcFailureCount: metrics.rpcFailureCount,
      threshold: thresholds.rpcFailureCount,
    },
  };
}

function isConditionFiring(
  kind: OperationalAlertKind,
  metrics: OperationalAlertMetrics,
  thresholds: OperationalAlertThresholds,
): boolean {
  if (kind === 'dead_letter_growth') return metrics.deadLetterCount >= thresholds.deadLetterCount;
  if (kind === 'indexer_lag') return metrics.indexerLagSeconds >= thresholds.indexerLagSeconds;
  return metrics.rpcFailureCount >= thresholds.rpcFailureCount;
}

/**
 * Evaluate operational metrics and decide which notifications to emit.
 *
 * Externally observable behavior:
 *  - A condition *fires* when its metric reaches its threshold
 *    (`deadLetterCount >= 25`, `indexerLagSeconds >= 300`, `rpcFailureCount >= 5`
 *    by default; override via `thresholds`).
 *  - The first evaluation where a condition fires emits exactly one `firing`
 *    notification. While the condition keeps firing, further notifications are
 *    suppressed until `cooldownMs` (default 15 min) has elapsed since the last
 *    one, then a single reminder is emitted.
 *  - When a firing condition drops below its threshold, exactly one `recovery`
 *    notification is emitted and the condition is marked not firing.
 *  - Notifications contain only counts, durations and thresholds — never event
 *    payloads, transaction data, URLs or secrets.
 *  - The function is pure: it never throws and never performs I/O. Persist the
 *    returned `state` (e.g. in `OperationalAlertState`) and pass it back on the
 *    next call.
 *
 * @param metrics Current metric snapshot.
 * @param clock Injectable clock (defaults to `Date.now`) for deterministic tests.
 * @param previousState State returned by the previous evaluation.
 * @param thresholds Optional threshold/cooldown overrides.
 */
export function evaluateOperationalAlerts(
  metrics: OperationalAlertMetrics,
  clock: () => number = Date.now,
  previousState: OperationalAlertState[] = [],
  thresholds?: Partial<OperationalAlertThresholds>,
): OperationalAlertEvaluation {
  const limits = readThresholds(thresholds);
  const now = clock();
  const kinds: OperationalAlertKind[] = ['dead_letter_growth', 'indexer_lag', 'rpc_failure'];
  const notifications: OperationalAlertNotification[] = [];
  const state: OperationalAlertState[] = [];

  for (const kind of kinds) {
    const dedupeKey = buildOperationalDedupeKey(kind);
    const prior = previousState.find((s) => s.kind === kind);
    const firing = isConditionFiring(kind, metrics, limits);
    const { message, details } = describeCondition(kind, metrics, limits);

    if (firing) {
      const wasFiring = prior?.firing ?? false;
      const lastNotifiedAt = prior?.lastNotifiedAt ?? null;
      const cooldownElapsed =
        lastNotifiedAt === null || now - lastNotifiedAt >= limits.cooldownMs;

      if (!wasFiring || cooldownElapsed) {
        notifications.push({
          kind,
          dedupeKey,
          transition: 'firing',
          message,
          details,
          timestamp: new Date(now).toISOString(),
        });
        state.push({
          kind,
          dedupeKey,
          firing: true,
          lastNotifiedAt: now,
          firingSince: prior?.firingSince ?? now,
        });
      } else {
        state.push({
          kind,
          dedupeKey,
          firing: true,
          lastNotifiedAt,
          firingSince: prior?.firingSince ?? now,
        });
      }
      continue;
    }

    if (prior?.firing) {
      notifications.push({
        kind,
        dedupeKey,
        transition: 'recovery',
        message: `Recovered: ${message}`,
        details,
        timestamp: new Date(now).toISOString(),
      });
    }
    state.push({
      kind,
      dedupeKey,
      firing: false,
      lastNotifiedAt: prior?.lastNotifiedAt ?? null,
      firingSince: null,
    });
  }

  return { notifications, state };
}

/** Build the provider-specific JSON body for an operational alert. */
export function buildOperationalAlertPayload(
  kind: AlertWebhookKind,
  notification: OperationalAlertNotification,
): Record<string, unknown> {
  const emoji = notification.transition === 'recovery' ? '✅' : '🚨';
  const title =
    notification.transition === 'recovery'
      ? `Recovered: ${notification.kind}`
      : `Operational alert: ${notification.kind}`;
  const fieldEntries = Object.entries(notification.details).map(([name, value]) => ({
    name,
    value: String(value),
  }));

  if (kind === 'slack') {
    return {
      text: `${emoji} ${title}`,
      blocks: [
        {
          type: 'header',
          text: { type: 'plain_text', text: `${emoji} ${title}`, emoji: true },
        },
        {
          type: 'section',
          text: { type: 'mrkdwn', text: notification.message },
        },
        {
          type: 'section',
          fields: fieldEntries.map((f) => ({
            type: 'mrkdwn',
            text: `*${f.name}:*\n${f.value}`,
          })),
        },
      ],
    };
  }

  if (kind === 'discord') {
    return {
      content: `${emoji} **${title}**`,
      embeds: [
        {
          title,
          color: notification.transition === 'recovery' ? 0x2ecc71 : 0xe74c3c,
          timestamp: notification.timestamp,
          description: notification.message,
          fields: fieldEntries.map((f) => ({ name: f.name, value: f.value, inline: true })),
        },
      ],
    };
  }

  return {
    text: `${emoji} ${title}`,
    kind: notification.kind,
    dedupeKey: notification.dedupeKey,
    transition: notification.transition,
    message: notification.message,
    details: notification.details,
    timestamp: notification.timestamp,
  };
}

/**
 * Deliver a single operational notification to `ALERT_WEBHOOK_URL`.
 *
 * @returns `true` when the webhook accepted the message. Never throws: alerting
 *   is best-effort and must not take down the caller (the indexer loop).
 */
export async function sendOperationalAlert(
  notification: OperationalAlertNotification,
): Promise<boolean> {
  const url = getAlertWebhookUrl();
  if (!url) {
    return false;
  }

  try {
    const payload = buildOperationalAlertPayload(detectWebhookKind(url), notification);
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(10_000),
    });

    if (!response.ok) {
      logger.warn(
        `[Alert] Operational webhook returned HTTP ${response.status} for ${notification.kind}`,
      );
      return false;
    }

    return true;
  } catch (err) {
    logger.error(`[Alert] Failed to deliver operational webhook for ${notification.kind}:`, err);
    return false;
  }
}
