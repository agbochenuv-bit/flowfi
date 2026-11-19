import { useCallback, useMemo, useState } from 'react';

export interface StreamRecipient {
  address: string;
  weight: number;
}

export interface StreamRecipientAmount {
  address: string;
  weight: number;
  amount: bigint;
}

export interface StreamFormValidation {
  valid: boolean;
  errors: string[];
  recipientErrors: Array<{ index: number; errors: string[] }>;
  totalWeightError?: string;
  amountError?: string;
}

export interface UseStreamFormOptions {
  initialRecipients?: StreamRecipient[];
  initialTotalAmount?: string | bigint;
  initialToken?: string;
  initialDuration?: number;
}

export interface UseStreamFormResult {
  recipients: StreamRecipient[];
  totalAmount: string;
  token: string;
  duration: number;
  totalWeight: number;
  recipientAmounts: StreamRecipientAmount[];
  validation: StreamFormValidation;
  canReview: boolean;
  addRecipient: (recipient?: Partial<StreamRecipient>) => void;
  removeRecipient: (index: number) => void;
  updateRecipient: (index: number, patch: Partial<StreamRecipient>) => void;
  setRecipients: (recipients: StreamRecipient[]) => void;
  setTotalAmount: (amount: string) => void;
  setToken: (token: string) => void;
  setDuration: (duration: number) => void;
  reset: () => void;
}

const ADDRESS_PATTERN = /^G[A-Z2-7]{55}$/;
const MAX_RECIPIENTS = 100;
const MAX_WEIGHT = 1_000_000;
const MAX_TOTAL_WEIGHT = 10_000_000;

function isValidAddress(address: string): boolean {
  return ADDRESS_PATTERN.test(address.trim());
}

function parseAmount(value: string): bigint | null {
  const trimmed = value.trim();
  if (trimmed === '') return null;
  if (!/^\d+$/.test(trimmed)) return null;
  try {
    return BigInt(trimmed);
  } catch {
    return null;
  }
}

/**
 * Distribute `total` across recipients by weight using integer arithmetic and
 * largest-remainder rounding so that the sum of the parts equals `total`
 * exactly. This mirrors the on-chain contract's distribution rules.
 */
export function distributeByWeight(
  total: bigint,
  recipients: StreamRecipient[],
): StreamRecipientAmount[] {
  const totalWeight = recipients.reduce(
    (sum, r) => sum + (Number.isFinite(r.weight) && r.weight > 0 ? Math.floor(r.weight) : 0),
    0,
  );

  if (totalWeight <= 0 || total <= 0n) {
    return recipients.map((r) => ({ address: r.address, weight: r.weight, amount: 0n }));
  }

  const totalWeightBig = BigInt(totalWeight);
  const base: bigint[] = [];
  const remainders: Array<{ index: number; remainder: bigint }> = [];
  let distributed = 0n;

  recipients.forEach((r, index) => {
    const weight = Number.isFinite(r.weight) && r.weight > 0 ? Math.floor(r.weight) : 0;
    const weightBig = BigInt(weight);
    const numerator = total * weightBig;
    const share = numerator / totalWeightBig;
    const remainder = numerator % totalWeightBig;
    base.push(share);
    distributed += share;
    remainders.push({ index, remainder });
  });

  let leftover = total - distributed;

  // Largest-remainder: assign remaining units to recipients with the largest
  // fractional remainders, breaking ties by original order for determinism.
  remainders.sort((a, b) => {
    if (a.remainder === b.remainder) return a.index - b.index;
    return a.remainder > b.remainder ? -1 : 1;
  });

  let cursor = 0;
  while (leftover > 0n && remainders.length > 0) {
    const target = remainders[cursor % remainders.length];
    base[target.index] += 1n;
    leftover -= 1n;
    cursor += 1;
  }

  return recipients.map((r, index) => ({
    address: r.address,
    weight: r.weight,
    amount: base[index],
  }));
}

const DEFAULT_RECIPIENT: StreamRecipient = { address: '', weight: 1 };

export function useStreamForm(options: UseStreamFormOptions = {}): UseStreamFormResult {
  const initialRecipients =
    options.initialRecipients && options.initialRecipients.length > 0
      ? options.initialRecipients
      : [{ ...DEFAULT_RECIPIENT }];

  const [recipients, setRecipientsState] = useState<StreamRecipient[]>(initialRecipients);
  const [totalAmount, setTotalAmountState] = useState<string>(
    options.initialTotalAmount !== undefined ? String(options.initialTotalAmount) : '',
  );
  const [token, setTokenState] = useState<string>(options.initialToken ?? '');
  const [duration, setDurationState] = useState<number>(options.initialDuration ?? 0);

  const setRecipients = useCallback((next: StreamRecipient[]) => {
    setRecipientsState(next.length > 0 ? next : [{ ...DEFAULT_RECIPIENT }]);
  }, []);

  const addRecipient = useCallback((recipient?: Partial<StreamRecipient>) => {
    setRecipientsState((prev) => {
      if (prev.length >= MAX_RECIPIENTS) return prev;
      return [
        ...prev,
        {
          address: recipient?.address ?? '',
          weight: recipient?.weight ?? 1,
        },
      ];
    });
  }, []);

  const removeRecipient = useCallback((index: number) => {
    setRecipientsState((prev) => {
      if (prev.length <= 1) return prev;
      if (index < 0 || index >= prev.length) return prev;
      return prev.filter((_, i) => i !== index);
    });
  }, []);

  const updateRecipient = useCallback((index: number, patch: Partial<StreamRecipient>) => {
    setRecipientsState((prev) => {
      if (index < 0 || index >= prev.length) return prev;
      return prev.map((r, i) => (i === index ? { ...r, ...patch } : r));
    });
  }, []);

  const setTotalAmount = useCallback((amount: string) => {
    setTotalAmountState(amount);
  }, []);

  const setToken = useCallback((next: string) => {
    setTokenState(next);
  }, []);

  const setDuration = useCallback((next: number) => {
    setDurationState(next);
  }, []);

  const reset = useCallback(() => {
    setRecipientsState([{ ...DEFAULT_RECIPIENT }]);
    setTotalAmountState('');
    setTokenState('');
    setDurationState(0);
  }, []);

  const totalWeight = useMemo(
    () =>
      recipients.reduce(
        (sum, r) => sum + (Number.isFinite(r.weight) && r.weight > 0 ? Math.floor(r.weight) : 0),
        0,
      ),
    [recipients],
  );

  const parsedTotal = useMemo(() => parseAmount(totalAmount), [totalAmount]);

  const recipientAmounts = useMemo<StreamRecipientAmount[]>(() => {
    if (parsedTotal === null || parsedTotal <= 0n) {
      return recipients.map((r) => ({ address: r.address, weight: r.weight, amount: 0n }));
    }
    return distributeByWeight(parsedTotal, recipients);
  }, [parsedTotal, recipients]);

  const validation = useMemo<StreamFormValidation>(() => {
    const errors: string[] = [];
    const recipientErrors: Array<{ index: number; errors: string[] }> = [];

    if (recipients.length === 0) {
      errors.push('At least one recipient is required.');
    }
    if (recipients.length > MAX_RECIPIENTS) {
      errors.push(`At most ${MAX_RECIPIENTS} recipients are allowed.`);
    }

    const seen = new Set<string>();
    recipients.forEach((r, index) => {
      const errs: string[] = [];
      const address = r.address.trim();
      if (address === '') {
        errs.push('Recipient address is required.');
      } else if (!isValidAddress(address)) {
        errs.push('Recipient address is invalid.');
      } else if (seen.has(address)) {
        errs.push('Recipient address is duplicated.');
      } else {
        seen.add(address);
      }

      if (!Number.isFinite(r.weight) || !Number.isInteger(r.weight)) {
        errs.push('Weight must be an integer.');
      } else if (r.weight <= 0) {
        errs.push('Weight must be greater than zero.');
      } else if (r.weight > MAX_WEIGHT) {
        errs.push(`Weight must not exceed ${MAX_WEIGHT}.`);
      }

      if (errs.length > 0) {
        recipientErrors.push({ index, errors: errs });
      }
    });

    let totalWeightError: string | undefined;
    if (totalWeight <= 0) {
      totalWeightError = 'Total weight must be greater than zero.';
    } else if (totalWeight > MAX_TOTAL_WEIGHT) {
      totalWeightError = `Total weight must not exceed ${MAX_TOTAL_WEIGHT}.`;
    }
    if (totalWeightError) {
      errors.push(totalWeightError);
    }

    let amountError: string | undefined;
    if (totalAmount.trim() === '') {
      amountError = 'Total amount is required.';
    } else if (parsedTotal === null) {
      amountError = 'Total amount must be a non-negative integer.';
    } else if (parsedTotal <= 0n) {
      amountError = 'Total amount must be greater than zero.';
    }
    if (amountError) {
      errors.push(amountError);
    }

    if (token.trim() === '') {
      errors.push('Token is required.');
    }

    if (!Number.isFinite(duration) || !Number.isInteger(duration) || duration <= 0) {
      errors.push('Duration must be a positive integer.');
    }

    if (recipientErrors.length > 0) {
      errors.push('One or more recipients are invalid.');
    }

    return {
      valid: errors.length === 0,
      errors,
      recipientErrors,
      totalWeightError,
      amountError,
    };
  }, [recipients, totalWeight, totalAmount, parsedTotal, token, duration]);

  const canReview = validation.valid;

  return {
    recipients,
    totalAmount,
    token,
    duration,
    totalWeight,
    recipientAmounts,
    validation,
    canReview,
    addRecipient,
    removeRecipient,
    updateRecipient,
    setRecipients,
    setTotalAmount,
    setToken,
    setDuration,
    reset,
  };
}

export default useStreamForm;