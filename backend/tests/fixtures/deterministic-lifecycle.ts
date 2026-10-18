/**
 * Deterministic Lifecycle Test Fixtures & Virtual Clock
 *
 * Provides standardized fake clocks, deterministic Soroban event fixtures,
 * and seeded database setups for backend stream lifecycle suites.
 * Eliminates wall-clock dependencies, sleeps, and timing race conditions
 * across pause/resume, accrual, expiry, replay, and analytics tests.
 */

export class DeterministicClock {
  private currentMs: number;
  private originalDateNow?: () => number;

  constructor(initialMs: number = 1_700_000_000_000) {
    this.currentMs = initialMs;
  }

  /** Current timestamp in milliseconds */
  nowMs(): number {
    return this.currentMs;
  }

  /** Current timestamp in whole seconds as BigInt */
  nowSeconds(): bigint {
    return BigInt(Math.floor(this.currentMs / 1000));
  }

  /** Current Date object */
  nowDate(): Date {
    return new Date(this.currentMs);
  }

  /** Advance clock forward by given number of seconds */
  advanceSeconds(seconds: number): void {
    if (seconds < 0) throw new Error('Clock cannot travel backward');
    this.currentMs += seconds * 1000;
  }

  /** Advance clock forward by given number of milliseconds */
  advanceMs(ms: number): void {
    if (ms < 0) throw new Error('Clock cannot travel backward');
    this.currentMs += ms;
  }

  /** Jump clock to an explicit target timestamp */
  advanceTo(targetMs: number): void {
    if (targetMs < this.currentMs) throw new Error('Target must be in the future');
    this.currentMs = targetMs;
  }

  /** Installs the clock by overriding Date.now() */
  install(): () => void {
    this.originalDateNow = Date.now;
    Date.now = () => this.currentMs;

    return () => {
      if (this.originalDateNow) {
        Date.now = this.originalDateNow;
      }
    };
  }
}

export interface MockSorobanEvent {
  id: string;
  type: string;
  contractId: string;
  topic: string[];
  data: Record<string, unknown>;
  ledger: number;
  ledgerClosedAt: string;
  txHash: string;
  inSuccessfulContractCall: boolean;
}

export interface StreamLifecycleParams {
  streamId: string;
  sender: string;
  recipient: string;
  token: string;
  totalAmount: string;
  ratePerSecond: string;
  startTime: number;
  stopTime: number;
  contractId?: string;
}

/**
 * Creates deterministic Soroban contract event fixtures with predictable
 * ledger sequences, transaction hashes, and ISO timestamps.
 */
export class DeterministicEventFactory {
  private sequence: number = 100_000;
  private contractId: string;

  constructor(contractId: string = 'CDER7M4KVBGFU56MNO72R6Y24T4EQFOGZ5VNYPQZZUOGHHLW6J2PQL47') {
    this.contractId = contractId;
  }

  private nextLedger(): number {
    return ++this.sequence;
  }

  private nextTxHash(index: number): string {
    return `0x${index.toString(16).padStart(8, '0')}${'0'.repeat(56)}`;
  }

  createStreamCreated(params: StreamLifecycleParams, atSeconds: number): MockSorobanEvent {
    const ledger = this.nextLedger();
    return {
      id: `${ledger}-001`,
      type: 'contract',
      contractId: params.contractId || this.contractId,
      topic: ['stream_created', params.streamId],
      data: {
        stream_id: params.streamId,
        sender: params.sender,
        recipient: params.recipient,
        token: params.token,
        total_amount: params.totalAmount,
        rate_per_second: params.ratePerSecond,
        start_time: params.startTime,
        stop_time: params.stopTime,
      },
      ledger,
      ledgerClosedAt: new Date(atSeconds * 1000).toISOString(),
      txHash: this.nextTxHash(ledger),
      inSuccessfulContractCall: true,
    };
  }

  createStreamPaused(streamId: string, by: string, atSeconds: number): MockSorobanEvent {
    const ledger = this.nextLedger();
    return {
      id: `${ledger}-001`,
      type: 'contract',
      contractId: this.contractId,
      topic: ['stream_paused', streamId],
      data: {
        stream_id: streamId,
        paused_by: by,
        paused_at: atSeconds,
      },
      ledger,
      ledgerClosedAt: new Date(atSeconds * 1000).toISOString(),
      txHash: this.nextTxHash(ledger),
      inSuccessfulContractCall: true,
    };
  }

  createStreamResumed(streamId: string, by: string, atSeconds: number): MockSorobanEvent {
    const ledger = this.nextLedger();
    return {
      id: `${ledger}-001`,
      type: 'contract',
      contractId: this.contractId,
      topic: ['stream_resumed', streamId],
      data: {
        stream_id: streamId,
        resumed_by: by,
        resumed_at: atSeconds,
      },
      ledger,
      ledgerClosedAt: new Date(atSeconds * 1000).toISOString(),
      txHash: this.nextTxHash(ledger),
      inSuccessfulContractCall: true,
    };
  }

  createWithdrawal(streamId: string, recipient: string, amount: string, atSeconds: number): MockSorobanEvent {
    const ledger = this.nextLedger();
    return {
      id: `${ledger}-001`,
      type: 'contract',
      contractId: this.contractId,
      topic: ['stream_withdrawn', streamId],
      data: {
        stream_id: streamId,
        recipient,
        amount,
        withdrawn_at: atSeconds,
      },
      ledger,
      ledgerClosedAt: new Date(atSeconds * 1000).toISOString(),
      txHash: this.nextTxHash(ledger),
      inSuccessfulContractCall: true,
    };
  }

  createStreamCancelled(streamId: string, by: string, senderRefund: string, recipientPayout: string, atSeconds: number): MockSorobanEvent {
    const ledger = this.nextLedger();
    return {
      id: `${ledger}-001`,
      type: 'contract',
      contractId: this.contractId,
      topic: ['stream_cancelled', streamId],
      data: {
        stream_id: streamId,
        cancelled_by: by,
        sender_refund: senderRefund,
        recipient_payout: recipientPayout,
        cancelled_at: atSeconds,
      },
      ledger,
      ledgerClosedAt: new Date(atSeconds * 1000).toISOString(),
      txHash: this.nextTxHash(ledger),
      inSuccessfulContractCall: true,
    };
  }
}

/**
 * Calculates theoretical accrued amount for a constant-rate stream at an explicit timestamp.
 */
export function calculateAccruedAmount(
  startTime: number,
  stopTime: number,
  ratePerSecond: bigint,
  currentTimestamp: number,
  isPaused: boolean = false,
  pausedDurationSeconds: number = 0
): bigint {
  if (currentTimestamp <= startTime) return 0n;

  const effectiveEnd = Math.min(currentTimestamp, stopTime);
  const totalElapsed = effectiveEnd - startTime;
  const activeElapsed = Math.max(0, totalElapsed - (isPaused ? pausedDurationSeconds : 0));

  return BigInt(activeElapsed) * ratePerSecond;
}
