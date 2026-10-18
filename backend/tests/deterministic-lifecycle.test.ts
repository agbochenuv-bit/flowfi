import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  DeterministicClock,
  DeterministicEventFactory,
  calculateAccruedAmount,
} from './fixtures/deterministic-lifecycle.js';

describe('Deterministic Lifecycle and Clock Fixtures', () => {
  let clock: DeterministicClock;
  let restoreClock: () => void;
  const factory = new DeterministicEventFactory();

  beforeEach(() => {
    // Start at a deterministic baseline timestamp (e.g. 1,700,000,000s)
    clock = new DeterministicClock(1_700_000_000_000);
    restoreClock = clock.install();
  });

  afterEach(() => {
    if (restoreClock) restoreClock();
  });

  it('virtual clock steps forward predictably without wall-clock drift', () => {
    expect(Date.now()).toBe(1_700_000_000_000);
    expect(clock.nowSeconds()).toBe(1_700_000_000n);

    clock.advanceSeconds(60);
    expect(Date.now()).toBe(1_700_000_060_000);
    expect(clock.nowSeconds()).toBe(1_700_000_060n);

    clock.advanceTo(1_700_000_300_000);
    expect(Date.now()).toBe(1_700_000_300_000);
  });

  it('calculates deterministic stream accrual across pause and resume transitions', () => {
    const startTime = 1_700_000_000;
    const stopTime = 1_700_000_100;
    const ratePerSecond = 10n; // 10 units/sec

    // T=0: before start
    expect(calculateAccruedAmount(startTime, stopTime, ratePerSecond, 1_699_999_990)).toBe(0n);

    // T=20s: 200 units
    expect(calculateAccruedAmount(startTime, stopTime, ratePerSecond, startTime + 20)).toBe(200n);

    // T=50s with 10s pause: 40s active = 400 units
    expect(calculateAccruedAmount(startTime, stopTime, ratePerSecond, startTime + 50, true, 10)).toBe(400n);

    // Past stopTime (T=120s): capped at 100s = 1000 units
    expect(calculateAccruedAmount(startTime, stopTime, ratePerSecond, startTime + 120)).toBe(1000n);
  });

  it('produces identical Soroban event sequences and hashes across repeated runs', () => {
    const params = {
      streamId: 'stream-12345',
      sender: 'GBEVJL4RM4IIUHWMB6N2X2LDYV5XEXR7GHCJ2GZCHP3FHLREX3W2TIIY',
      recipient: 'GC2B26ZCT46R56743A5W3H2PBX4X5I3J5J3H2PBX4X5I3J5J3H2PBX4X',
      token: 'CAS3J7GYLGXMF6TDJBBYYSE3VUMAS45G357RI2URK3W3WDPOQEBW4GBM',
      totalAmount: '10000000',
      ratePerSecond: '100',
      startTime: 1_700_000_000,
      stopTime: 1_700_100_000,
    };

    const runA = factory.createStreamCreated(params, 1_700_000_000);
    const runAPause = factory.createStreamPaused(params.streamId, params.sender, 1_700_000_500);

    expect(runA.topic[0]).toBe('stream_created');
    expect(runA.topic[1]).toBe(params.streamId);
    expect(runA.data.total_amount).toBe('10000000');
    expect(runAPause.topic[0]).toBe('stream_paused');
    expect(runAPause.data.paused_at).toBe(1_700_000_500);
  });
});
