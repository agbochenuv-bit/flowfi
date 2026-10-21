import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const webhookMocks = vi.hoisted(() => ({
  resolveSafeWebhookTarget: vi.fn(),
  postToPinnedTarget: vi.fn(),
}));

vi.mock('../src/logger.js', () => ({
  default: { error: vi.fn(), info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));
vi.mock('../src/services/webhook.service.js', () => webhookMocks);

import {
  buildDeadLetterPayload,
  buildTriageUrl,
  detectWebhookKind,
  getAlertWebhookUrl,
  sendDeadLetterAlert,
  type DeadLetterAlert,
} from '../src/services/alert.service.js';
import { postToPinnedTarget, resolveSafeWebhookTarget } from '../src/services/webhook.service.js';
import {
  evaluateOperationalAlerts,
  resetOperationalAlertState,
  type OperationalAlertSignals,
} from '../src/services/alert.service.js';

const ALERT: DeadLetterAlert = {
  eventId: 'event-0001',
  eventType: 'stream_created',
  ledgerSequence: 482910,
  txHash: 'abc123',
  errorMessage: 'StreamCreated #7: missing body fields',
  errorStack: 'Error: boom\n  at handler (worker.ts:1:1)',
  attempts: 5,
};

describe('alert webhook configuration', () => {
  const saved: Record<string, string | undefined> = {};
  const KEYS = ['ALERT_WEBHOOK_URL', 'ADMIN_DASHBOARD_URL', 'FRONTEND_URL'] as const;

  beforeEach(() => {
    for (const key of KEYS) saved[key] = process.env[key];
    for (const key of KEYS) delete process.env[key];
  });

  afterEach(() => {
    for (const key of KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
    vi.unstubAllGlobals();
  });

  it('returns undefined when ALERT_WEBHOOK_URL is unset or blank', () => {
    expect(getAlertWebhookUrl()).toBeUndefined();
    process.env.ALERT_WEBHOOK_URL = '   ';
    expect(getAlertWebhookUrl()).toBeUndefined();
  });

  it('trims a configured webhook URL', () => {
    process.env.ALERT_WEBHOOK_URL = '  https://hooks.slack.com/services/x  ';
    expect(getAlertWebhookUrl()).toBe('https://hooks.slack.com/services/x');
  });

  it('detects the provider from the webhook URL', () => {
    expect(detectWebhookKind('https://hooks.slack.com/services/x')).toBe('slack');
    expect(detectWebhookKind('https://discord.com/api/webhooks/1/abc')).toBe('discord');
    expect(detectWebhookKind('https://discordapp.com/api/webhooks/1/abc')).toBe('discord');
    expect(detectWebhookKind('https://alerts.example.com/hook')).toBe('generic');
  });

  it('builds a triage deep link and honours ADMIN_DASHBOARD_URL', () => {
    expect(buildTriageUrl('evt 1')).toContain('/admin/indexer/dead-letter?eventId=evt%201');
    process.env.ADMIN_DASHBOARD_URL = 'https://ops.flowfi.xyz/';
    expect(buildTriageUrl('evt-1')).toBe(
      'https://ops.flowfi.xyz/admin/indexer/dead-letter?eventId=evt-1',
    );
  });
});

describe('dead-letter payload formatting', () => {
  it('builds Slack Block Kit with ledger, tx hash, error and triage action', () => {
    const payload = buildDeadLetterPayload('slack', ALERT) as {
      text: string;
      blocks: Array<{ type: string; text?: { text: string }; elements?: unknown[] }>;
    };

    expect(payload.text).toContain('stream_created');
    expect(payload.blocks[0]!.type).toBe('header');
    const serialized = JSON.stringify(payload);
    expect(serialized).toContain('482910');
    expect(serialized).toContain('abc123');
    expect(serialized).toContain('missing body fields');
    expect(payload.blocks.some((b) => b.type === 'actions')).toBe(true);
  });

  it('builds a Discord embed with rich fields', () => {
    const payload = buildDeadLetterPayload('discord', ALERT) as {
      content: string;
      embeds: Array<{ fields: Array<{ name: string; value: string }>; color: number }>;
    };

    expect(payload.content).toContain('Indexer dead-letter');
    expect(payload.embeds).toHaveLength(1);
    const names = payload.embeds[0]!.fields.map((f) => f.name);
    expect(names).toEqual(
      expect.arrayContaining(['Ledger', 'Attempts', 'Tx hash', 'Error', 'Stack']),
    );
  });

  it('builds a generic JSON envelope for unknown receivers', () => {
    const payload = buildDeadLetterPayload('generic', ALERT);
    expect(payload).toMatchObject({
      eventId: 'event-0001',
      eventType: 'stream_created',
      ledgerSequence: 482910,
      txHash: 'abc123',
      attempts: 5,
    });
    expect(typeof payload.triageUrl).toBe('string');
  });
});

describe('sendDeadLetterAlert', () => {
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    saved['ALERT_WEBHOOK_URL'] = process.env.ALERT_WEBHOOK_URL;
    webhookMocks.resolveSafeWebhookTarget.mockResolvedValue({
      url: new URL('https://hooks.slack.com/services/x'),
      addresses: [{ address: '8.8.8.8', family: 4 }],
    });
    webhookMocks.postToPinnedTarget.mockResolvedValue(200);
  });

  afterEach(() => {
    if (saved['ALERT_WEBHOOK_URL'] === undefined) delete process.env.ALERT_WEBHOOK_URL;
    else process.env.ALERT_WEBHOOK_URL = saved['ALERT_WEBHOOK_URL'];
    vi.unstubAllGlobals();
  });

  it('is a no-op when alerting is not configured', async () => {
    delete process.env.ALERT_WEBHOOK_URL;

    await expect(sendDeadLetterAlert(ALERT)).resolves.toBe(false);
    expect(resolveSafeWebhookTarget).not.toHaveBeenCalled();
    expect(postToPinnedTarget).not.toHaveBeenCalled();
  });

  it('POSTs the formatted payload to the configured webhook', async () => {
    process.env.ALERT_WEBHOOK_URL = 'https://hooks.slack.com/services/x';

    await expect(sendDeadLetterAlert(ALERT)).resolves.toBe(true);
    expect(resolveSafeWebhookTarget).toHaveBeenCalledWith('https://hooks.slack.com/services/x');
    expect(postToPinnedTarget).toHaveBeenCalledTimes(1);

    const [, addresses, headers, serializedBody] = vi.mocked(postToPinnedTarget).mock.calls[0]!;
    expect(addresses).toEqual([{ address: '8.8.8.8', family: 4 }]);
    expect(headers['Content-Type']).toBe('application/json');
    const body = JSON.parse(serializedBody);
    expect(body.blocks).toBeDefined();
  });

  it('returns false on a non-2xx response without throwing', async () => {
    process.env.ALERT_WEBHOOK_URL = 'https://discord.com/api/webhooks/1/abc';
    webhookMocks.postToPinnedTarget.mockResolvedValue(500);

    await expect(sendDeadLetterAlert(ALERT)).resolves.toBe(false);
  });

  it('swallows network errors so the indexer loop is never crashed', async () => {
    process.env.ALERT_WEBHOOK_URL = 'https://alerts.example.com/hook';
    webhookMocks.resolveSafeWebhookTarget.mockRejectedValue(new Error('ECONNREFUSED'));

    await expect(sendDeadLetterAlert(ALERT)).resolves.toBe(false);
  });
});

const SECRET = 'super-secret-token-value';
const RAW_PAYLOAD = '{"rawEventPayload":"leaked-body"}';

function signals(overrides: Partial<OperationalAlertSignals> = {}): OperationalAlertSignals {
  return {
    deadLetterCount: 0,
    indexerLagSeconds: 0,
    rpcFailureCount: 0,
    ...overrides,
  };
}

describe('operational alert thresholds', () => {
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    saved['ALERT_WEBHOOK_URL'] = process.env.ALERT_WEBHOOK_URL;
    process.env.ALERT_WEBHOOK_URL = 'https://hooks.slack.com/services/x';
    resetOperationalAlertState();
  });

  afterEach(() => {
    if (saved['ALERT_WEBHOOK_URL'] === undefined) delete process.env.ALERT_WEBHOOK_URL;
    else process.env.ALERT_WEBHOOK_URL = saved['ALERT_WEBHOOK_URL'];
    resetOperationalAlertState();
    vi.unstubAllGlobals();
  });

  it('does not fire below the dead-letter threshold', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    vi.stubGlobal('fetch', fetchMock);

    const result = await evaluateOperationalAlerts(signals({ deadLetterCount: 9 }), {
      deadLetterThreshold: 10,
    });
    expect(result.fired).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('fires exactly at the dead-letter threshold boundary', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    vi.stubGlobal('fetch', fetchMock);

    const result = await evaluateOperationalAlerts(signals({ deadLetterCount: 10 }), {
      deadLetterThreshold: 10,
    });
    expect(result.fired).toContain('dead_letter_growth');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('fires above the dead-letter threshold', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    vi.stubGlobal('fetch', fetchMock);

    const result = await evaluateOperationalAlerts(signals({ deadLetterCount: 42 }), {
      deadLetterThreshold: 10,
    });
    expect(result.fired).toContain('dead_letter_growth');
  });

  it('fires at and above the indexer lag threshold', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    vi.stubGlobal('fetch', fetchMock);

    const below = await evaluateOperationalAlerts(signals({ indexerLagSeconds: 299 }), {
      indexerLagThresholdSeconds: 300,
    });
    expect(below.fired).toEqual([]);

    const at = await evaluateOperationalAlerts(signals({ indexerLagSeconds: 300 }), {
      indexerLagThresholdSeconds: 300,
    });
    expect(at.fired).toContain('indexer_lag');

    const above = await evaluateOperationalAlerts(signals({ indexerLagSeconds: 900 }), {
      indexerLagThresholdSeconds: 300,
    });
    expect(above.fired).toContain('indexer_lag');
  });

  it('fires at and above the RPC failure threshold', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    vi.stubGlobal('fetch', fetchMock);

    const below = await evaluateOperationalAlerts(signals({ rpcFailureCount: 4 }), {
      rpcFailureThreshold: 5,
    });
    expect(below.fired).toEqual([]);

    const at = await evaluateOperationalAlerts(signals({ rpcFailureCount: 5 }), {
      rpcFailureThreshold: 5,
    });
    expect(at.fired).toContain('rpc_failure');

    const above = await evaluateOperationalAlerts(signals({ rpcFailureCount: 12 }), {
      rpcFailureThreshold: 5,
    });
    expect(above.fired).toContain('rpc_failure');
  });
});

describe('operational alert deduplication and recovery', () => {
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    saved['ALERT_WEBHOOK_URL'] = process.env.ALERT_WEBHOOK_URL;
    process.env.ALERT_WEBHOOK_URL = 'https://hooks.slack.com/services/x';
    resetOperationalAlertState();
  });

  afterEach(() => {
    if (saved['ALERT_WEBHOOK_URL'] === undefined) delete process.env.ALERT_WEBHOOK_URL;
    else process.env.ALERT_WEBHOOK_URL = saved['ALERT_WEBHOOK_URL'];
    resetOperationalAlertState();
    vi.unstubAllGlobals();
  });

  it('suppresses a second alert within the cooldown window', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    vi.stubGlobal('fetch', fetchMock);

    const first = await evaluateOperationalAlerts(signals({ deadLetterCount: 20 }), {
      deadLetterThreshold: 10,
      cooldownMs: 60_000,
    });
    expect(first.fired).toContain('dead_letter_growth');
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const second = await evaluateOperationalAlerts(signals({ deadLetterCount: 25 }), {
      deadLetterThreshold: 10,
      cooldownMs: 60_000,
    });
    expect(second.fired).toEqual([]);
    expect(second.suppressed).toContain('dead_letter_growth');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('re-fires after the cooldown elapses', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    vi.stubGlobal('fetch', fetchMock);

    await evaluateOperationalAlerts(signals({ deadLetterCount: 20 }), {
      deadLetterThreshold: 10,
      cooldownMs: 1_000,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await evaluateOperationalAlerts(signals({ deadLetterCount: 20 }), {
      deadLetterThreshold: 10,
      cooldownMs: 1_000,
      now: Date.now() + 5_000,
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('sends exactly one recovery notification then goes silent', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    vi.stubGlobal('fetch', fetchMock);

    await evaluateOperationalAlerts(signals({ indexerLagSeconds: 600 }), {
      indexerLagThresholdSeconds: 300,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const recovered = await evaluateOperationalAlerts(signals({ indexerLagSeconds: 0 }), {
      indexerLagThresholdSeconds: 300,
    });
    expect(recovered.recovered).toContain('indexer_lag');
    expect(fetchMock).toHaveBeenCalledTimes(2);

    const silent = await evaluateOperationalAlerts(signals({ indexerLagSeconds: 0 }), {
      indexerLagThresholdSeconds: 300,
    });
    expect(silent.recovered).toEqual([]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('does not send a recovery notification when nothing was firing', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    vi.stubGlobal('fetch', fetchMock);

    const result = await evaluateOperationalAlerts(signals({ rpcFailureCount: 0 }), {
      rpcFailureThreshold: 5,
    });
    expect(result.recovered).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('operational alerts with disabled integrations', () => {
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    saved['ALERT_WEBHOOK_URL'] = process.env.ALERT_WEBHOOK_URL;
    delete process.env.ALERT_WEBHOOK_URL;
    resetOperationalAlertState();
  });

  afterEach(() => {
    if (saved['ALERT_WEBHOOK_URL'] === undefined) delete process.env.ALERT_WEBHOOK_URL;
    else process.env.ALERT_WEBHOOK_URL = saved['ALERT_WEBHOOK_URL'];
    resetOperationalAlertState();
    vi.unstubAllGlobals();
  });

  it('performs no fetch and reports not delivered when unconfigured', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const result = await evaluateOperationalAlerts(signals({ deadLetterCount: 100 }), {
      deadLetterThreshold: 10,
    });
    expect(result.fired).toContain('dead_letter_growth');
    expect(result.delivered).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('operational alert payload hygiene', () => {
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    saved['ALERT_WEBHOOK_URL'] = process.env.ALERT_WEBHOOK_URL;
    process.env.ALERT_WEBHOOK_URL = 'https://hooks.slack.com/services/x';
    resetOperationalAlertState();
  });

  afterEach(() => {
    if (saved['ALERT_WEBHOOK_URL'] === undefined) delete process.env.ALERT_WEBHOOK_URL;
    else process.env.ALERT_WEBHOOK_URL = saved['ALERT_WEBHOOK_URL'];
    resetOperationalAlertState();
    vi.unstubAllGlobals();
  });

  it('never leaks raw event payloads or secrets into the webhook body', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    vi.stubGlobal('fetch', fetchMock);

    await evaluateOperationalAlerts(
      {
        deadLetterCount: 50,
        indexerLagSeconds: 900,
        rpcFailureCount: 9,
        // Adversarial extras that must never be serialized.
        rawEventPayload: RAW_PAYLOAD,
        secret: SECRET,
      } as OperationalAlertSignals,
      { deadLetterThreshold: 10, indexerLagThresholdSeconds: 300, rpcFailureThreshold: 5 },
    );

    expect(fetchMock).toHaveBeenCalled();
    for (const call of fetchMock.mock.calls) {
      const body = String(call[1]?.body ?? '');
      expect(body).not.toContain(RAW_PAYLOAD);
      expect(body).not.toContain('leaked-body');
      expect(body).not.toContain(SECRET);
    }
  });
});
