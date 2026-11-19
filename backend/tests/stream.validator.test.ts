import { describe, it, expect } from 'vitest';
import {
  createStreamSchema,
  evaluatePaymentPolicySchema,
} from '../src/validators/stream.validator.js';

describe('Stream Validator', () => {
  it('should validate valid stream data', () => {
    const validData = {
      streamId: '123',
      sender: 'GSENDER',
      recipient: 'GRECIPIENT',
      tokenAddress: 'TABC',
      ratePerSecond: '100',
      depositedAmount: '1000',
      startTime: 1622505600,
    };
    const result = createStreamSchema.safeParse(validData);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.streamId).toBe(123n);
    }
  });

  it('accepts a u64 streamId above int4 max (#829)', () => {
    const result = createStreamSchema.safeParse({
      streamId: '3000000000',
      sender: 'GSENDER',
      recipient: 'GRECIPIENT',
      tokenAddress: 'TABC',
      ratePerSecond: '100',
      depositedAmount: '1000',
      startTime: 1622505600,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.streamId).toBe(3_000_000_000n);
    }
  });

  it('should fail on invalid stream data', () => {
    const invalidData = {
      streamId: -1,
      sender: '',
      recipient: '',
      tokenAddress: '',
      ratePerSecond: 'abc',
      depositedAmount: '-100',
      startTime: 'not-a-timestamp',
    };
    const result = createStreamSchema.safeParse(invalidData);
    expect(result.success).toBe(false);
  });

  it('should reject ratePerSecond exceeding i128 max', () => {
    const data = {
      streamId: '123',
      sender: 'GSENDER',
      recipient: 'GRECIPIENT',
      tokenAddress: 'TABC',
      ratePerSecond: '170141183460469231731687303715884105728',
      depositedAmount: '1000',
      startTime: 1622505600,
    };
    const result = createStreamSchema.safeParse(data);
    expect(result.success).toBe(false);
    expect(result.error!.issues[0]!.message).toBe('Rate exceeds maximum allowed value');
  });

  it('should accept ratePerSecond at i128 max', () => {
    const data = {
      streamId: '123',
      sender: 'GSENDER',
      recipient: 'GRECIPIENT',
      tokenAddress: 'TABC',
      ratePerSecond: '170141183460469231731687303715884105727',
      depositedAmount: '1000',
      startTime: 1622505600,
    };
    const result = createStreamSchema.safeParse(data);
    expect(result.success).toBe(true);
  });

  describe('optional policyId', () => {
    const baseData = {
      streamId: '123',
      sender: 'GSENDER',
      recipient: 'GRECIPIENT',
      tokenAddress: 'TABC',
      ratePerSecond: '100',
      depositedAmount: '1000',
      startTime: 1622505600,
    };

    it('accepts a valid policyId', () => {
      const result = createStreamSchema.safeParse({
        ...baseData,
        policyId: 'policy-abc-123',
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.policyId).toBe('policy-abc-123');
      }
    });

    it('leaves policyId undefined when omitted (backwards compatible)', () => {
      const result = createStreamSchema.safeParse(baseData);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.policyId).toBeUndefined();
      }
    });

    it('rejects an empty policyId', () => {
      const result = createStreamSchema.safeParse({ ...baseData, policyId: '' });
      expect(result.success).toBe(false);
    });

    it('rejects a non-string policyId', () => {
      const result = createStreamSchema.safeParse({ ...baseData, policyId: 42 });
      expect(result.success).toBe(false);
    });
  });
});

describe('Evaluate Payment Policy Validator', () => {
  const validInput = {
    sender: 'GSENDER',
    recipient: 'GRECIPIENT',
    tokenAddress: 'TABC',
    amount: '1000',
    network: 'testnet',
  };

  it('accepts a valid evaluation request', () => {
    const result = evaluatePaymentPolicySchema.safeParse(validInput);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.amount).toBe(1000n);
    }
  });

  it('accepts an optional policyId', () => {
    const result = evaluatePaymentPolicySchema.safeParse({
      ...validInput,
      policyId: 'policy-abc-123',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.policyId).toBe('policy-abc-123');
    }
  });

  it('rejects a malformed amount', () => {
    for (const amount of ['abc', '-100', '1.5', '']) {
      const result = evaluatePaymentPolicySchema.safeParse({
        ...validInput,
        amount,
      });
      expect(result.success).toBe(false);
    }
  });

  it('rejects an amount exceeding i128 max', () => {
    const result = evaluatePaymentPolicySchema.safeParse({
      ...validInput,
      amount: '170141183460469231731687303715884105728',
    });
    expect(result.success).toBe(false);
  });

  it('accepts an amount at i128 max', () => {
    const result = evaluatePaymentPolicySchema.safeParse({
      ...validInput,
      amount: '170141183460469231731687303715884105727',
    });
    expect(result.success).toBe(true);
  });

  it('rejects a missing or empty tokenAddress', () => {
    const missing = evaluatePaymentPolicySchema.safeParse({
      sender: validInput.sender,
      recipient: validInput.recipient,
      amount: validInput.amount,
      network: validInput.network,
    });
    expect(missing.success).toBe(false);

    const empty = evaluatePaymentPolicySchema.safeParse({
      ...validInput,
      tokenAddress: '',
    });
    expect(empty.success).toBe(false);
  });

  it('rejects a missing or empty network', () => {
    const missing = evaluatePaymentPolicySchema.safeParse({
      sender: validInput.sender,
      recipient: validInput.recipient,
      tokenAddress: validInput.tokenAddress,
      amount: validInput.amount,
    });
    expect(missing.success).toBe(false);

    const empty = evaluatePaymentPolicySchema.safeParse({
      ...validInput,
      network: '',
    });
    expect(empty.success).toBe(false);
  });

  it('rejects missing sender or recipient', () => {
    const noSender = evaluatePaymentPolicySchema.safeParse({
      recipient: validInput.recipient,
      tokenAddress: validInput.tokenAddress,
      amount: validInput.amount,
      network: validInput.network,
    });
    expect(noSender.success).toBe(false);

    const noRecipient = evaluatePaymentPolicySchema.safeParse({
      sender: validInput.sender,
      tokenAddress: validInput.tokenAddress,
      amount: validInput.amount,
      network: validInput.network,
    });
    expect(noRecipient.success).toBe(false);
  });
});
