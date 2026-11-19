import React, { useCallback, useMemo, useState } from 'react';

export interface StreamRecipient {
  address: string;
  weight: number;
}

export interface StreamCreationWizardProps {
  /**
   * Total amount to be streamed, expressed in the smallest unit (stroops).
   */
  totalAmount: bigint | number | string;
  /**
   * Optional initial recipients. Defaults to a single recipient with weight 1.
   */
  initialRecipients?: StreamRecipient[];
  /**
   * Called when the user confirms the review step.
   */
  onConfirm?: (payload: {
    recipients: StreamRecipient[];
    totalAmount: bigint;
    totalWeight: number;
    amounts: bigint[];
  }) => void;
  /**
   * Called when the user rejects / goes back from the review step.
   */
  onReject?: () => void;
  /**
   * Optional class name for the outer container.
   */
  className?: string;
}

type WizardStep = 'configure' | 'review';

interface ValidationResult {
  errors: string[];
  totalWeight: number;
  amounts: bigint[];
  roundingMismatch: boolean;
  duplicateRecipients: string[];
  invalidWeights: string[];
}

const DEFAULT_RECIPIENTS: StreamRecipient[] = [{ address: '', weight: 1 }];

function toBigInt(value: bigint | number | string): bigint {
  if (typeof value === 'bigint') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || !Number.isInteger(value)) {
      throw new Error('totalAmount must be an integer');
    }
    return BigInt(value);
  }
  return BigInt(value);
}

function isValidAddress(address: string): boolean {
  // Basic non-empty check; deeper chain/network validation happens elsewhere.
  return typeof address === 'string' && address.trim().length > 0;
}

/**
 * Computes per-recipient amounts using the same integer division rules as the
 * contract: floor(total * weight / totalWeight) with the remainder assigned to
 * the last recipient so the sum always equals the total.
 */
export function computeRecipientAmounts(
  totalAmount: bigint,
  weights: number[],
): { amounts: bigint[]; totalWeight: number; roundingMismatch: boolean } {
  const totalWeight = weights.reduce((sum, w) => sum + w, 0);
  if (totalWeight <= 0) {
    return { amounts: weights.map(() => 0n), totalWeight, roundingMismatch: false };
  }

  const amounts: bigint[] = [];
  let allocated = 0n;
  const totalWeightBig = BigInt(totalWeight);

  for (let i = 0; i < weights.length; i += 1) {
    const weightBig = BigInt(weights[i]);
    const amount = (totalAmount * weightBig) / totalWeightBig;
    amounts.push(amount);
    allocated += amount;
  }

  const remainder = totalAmount - allocated;
  if (remainder !== 0n && amounts.length > 0) {
    amounts[amounts.length - 1] += remainder;
  }

  const sum = amounts.reduce((acc, a) => acc + a, 0n);
  const roundingMismatch = sum !== totalAmount;

  return { amounts, totalWeight, roundingMismatch };
}

export function validateRecipients(
  recipients: StreamRecipient[],
  totalAmount: bigint,
): ValidationResult {
  const errors: string[] = [];
  const invalidWeights: string[] = [];
  const duplicateRecipients: string[] = [];

  if (recipients.length === 0) {
    errors.push('At least one recipient is required.');
  }

  const seen = new Set<string>();
  for (const recipient of recipients) {
    const address = recipient.address.trim();
    if (!isValidAddress(address)) {
      errors.push('Every recipient must have a valid address.');
    } else if (seen.has(address)) {
      if (!duplicateRecipients.includes(address)) {
        duplicateRecipients.push(address);
      }
    } else {
      seen.add(address);
    }

    if (!Number.isInteger(recipient.weight) || recipient.weight <= 0) {
      invalidWeights.push(address || '(empty address)');
    }
  }

  if (duplicateRecipients.length > 0) {
    errors.push(
      `Duplicate recipients are not allowed: ${duplicateRecipients.join(', ')}.`,
    );
  }

  if (invalidWeights.length > 0) {
    errors.push(
      `Weights must be positive integers: ${invalidWeights.join(', ')}.`,
    );
  }

  const weights = recipients.map((r) => (Number.isInteger(r.weight) ? r.weight : 0));
  const { amounts, totalWeight, roundingMismatch } = computeRecipientAmounts(
    totalAmount,
    weights,
  );

  if (totalWeight <= 0) {
    errors.push('Total weight must be greater than zero.');
  }

  if (totalAmount <= 0n) {
    errors.push('Total amount must be greater than zero.');
  }

  if (roundingMismatch) {
    errors.push('Rounding mismatch: recipient amounts do not sum to the total.');
  }

  return {
    errors,
    totalWeight,
    amounts,
    roundingMismatch,
    duplicateRecipients,
    invalidWeights,
  };
}

export const StreamCreationWizard: React.FC<StreamCreationWizardProps> = ({
  totalAmount,
  initialRecipients,
  onConfirm,
  onReject,
  className,
}) => {
  const [step, setStep] = useState<WizardStep>('configure');
  const [recipients, setRecipients] = useState<StreamRecipient[]>(
    initialRecipients && initialRecipients.length > 0
      ? initialRecipients
      : DEFAULT_RECIPIENTS,
  );

  const parsedTotal = useMemo(() => {
    try {
      return toBigInt(totalAmount);
    } catch {
      return 0n;
    }
  }, [totalAmount]);

  const validation = useMemo(
    () => validateRecipients(recipients, parsedTotal),
    [recipients, parsedTotal],
  );

  const isValid = validation.errors.length === 0;

  const updateRecipient = useCallback(
    (index: number, patch: Partial<StreamRecipient>) => {
      setRecipients((prev) =>
        prev.map((r, i) => (i === index ? { ...r, ...patch } : r)),
      );
    },
    [],
  );

  const addRecipient = useCallback(() => {
    setRecipients((prev) => [...prev, { address: '', weight: 1 }]);
  }, []);

  const removeRecipient = useCallback((index: number) => {
    setRecipients((prev) => {
      if (prev.length <= 1) return prev;
      return prev.filter((_, i) => i !== index);
    });
  }, []);

  const handleReview = useCallback(() => {
    if (!isValid) return;
    setStep('review');
  }, [isValid]);

  const handleBack = useCallback(() => {
    setStep('configure');
  }, []);

  const handleConfirm = useCallback(() => {
    if (!isValid) return;
    onConfirm?.({
      recipients,
      totalAmount: parsedTotal,
      totalWeight: validation.totalWeight,
      amounts: validation.amounts,
    });
  }, [isValid, onConfirm, recipients, parsedTotal, validation]);

  const handleReject = useCallback(() => {
    onReject?.();
    setStep('configure');
  }, [onReject]);

  return (
    <div className={className} data-testid="stream-creation-wizard">
      <h2>Create Stream</h2>

      {validation.errors.length > 0 && (
        <div role="alert" aria-live="assertive" data-testid="validation-errors">
          <ul>
            {validation.errors.map((error) => (
              <li key={error}>{error}</li>
            ))}
          </ul>
        </div>
      )}

      {step === 'configure' && (
        <section aria-label="Configure recipients">
          <table>
            <thead>
              <tr>
                <th scope="col">Recipient</th>
                <th scope="col">Weight</th>
                <th scope="col">Actions</th>
              </tr>
            </thead>
            <tbody>
              {recipients.map((recipient, index) => (
                <tr key={index}>
                  <td>
                    <label htmlFor={`recipient-address-${index}`}>
                      Recipient address
                    </label>
                    <input
                      id={`recipient-address-${index}`}
                      type="text"
                      value={recipient.address}
                      onChange={(e) =>
                        updateRecipient(index, { address: e.target.value })
                      }
                      aria-invalid={!isValidAddress(recipient.address)}
                    />
                  </td>
                  <td>
                    <label htmlFor={`recipient-weight-${index}`}>Weight</label>
                    <input
                      id={`recipient-weight-${index}`}
                      type="number"
                      min={1}
                      step={1}
                      value={recipient.weight}
                      onChange={(e) =>
                        updateRecipient(index, {
                          weight: Number.parseInt(e.target.value, 10),
                        })
                      }
                      aria-invalid={
                        !Number.isInteger(recipient.weight) || recipient.weight <= 0
                      }
                    />
                  </td>
                  <td>
                    <button
                      type="button"
                      onClick={() => removeRecipient(index)}
                      disabled={recipients.length <= 1}
                      aria-label={`Remove recipient ${index + 1}`}
                    >
                      Remove
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>

          <button type="button" onClick={addRecipient}>
            Add recipient
          </button>

          <div>
            <button
              type="button"
              onClick={handleReview}
              disabled={!isValid}
              data-testid="review-button"
            >
              Review
            </button>
          </div>
        </section>
      )}

      {step === 'review' && (
        <section aria-label="Review stream" data-testid="review-step">
          <h3>Review</h3>
          <table>
            <thead>
              <tr>
                <th scope="col">Recipient</th>
                <th scope="col">Weight</th>
                <th scope="col">Amount</th>
              </tr>
            </thead>
            <tbody>
              {recipients.map((recipient, index) => (
                <tr key={index}>
                  <td>{recipient.address}</td>
                  <td>{recipient.weight}</td>
                  <td>{validation.amounts[index]?.toString() ?? '0'}</td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr>
                <th scope="row">Total</th>
                <td>{validation.totalWeight}</td>
                <td>{parsedTotal.toString()}</td>
              </tr>
            </tfoot>
          </table>

          <div>
            <button
              type="button"
              onClick={handleConfirm}
              disabled={!isValid}
              data-testid="confirm-button"
            >
              Confirm
            </button>
            <button
              type="button"
              onClick={handleReject}
              data-testid="reject-button"
            >
              Back
            </button>
          </div>
        </section>
      )}
    </div>
  );
};

export default StreamCreationWizard;