import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { StreamAction, StreamActionKind } from '../types/stream';

export type PreparedTransactionStatus =
  | 'prepared'
  | 'revalidated'
  | 'submitted'
  | 'rejected';

export interface PreparedTransaction {
  id: string;
  kind: StreamActionKind;
  payload: Record<string, unknown>;
  streamId: string;
  network: string;
  account: string;
  streamVersion: number;
  preparedAt: number;
  expiresAt: number;
  status: PreparedTransactionStatus;
}

export interface PrepareTransactionInput {
  kind: StreamActionKind;
  payload: Record<string, unknown>;
  streamId: string;
  network: string;
  account: string;
  streamVersion: number;
  ttlMs?: number;
}

export interface RevalidationContext {
  network: string;
  account: string;
  streamVersion: number;
  now?: number;
}

export type RevalidationResult =
  | { ok: true; transaction: PreparedTransaction }
  | { ok: false; reason: RevalidationFailureReason; message: string };

export type RevalidationFailureReason =
  | 'expired'
  | 'stale-stream'
  | 'network-mismatch'
  | 'account-mismatch'
  | 'already-submitted';

export const DEFAULT_PREPARED_TTL_MS = 5 * 60 * 1000;

let preparedCounter = 0;

function nextPreparedId(): string {
  preparedCounter += 1;
  return `prepared-${Date.now()}-${preparedCounter}`;
}

export function revalidatePreparedTransaction(
  transaction: PreparedTransaction,
  context: RevalidationContext,
): RevalidationResult {
  const now = context.now ?? Date.now();

  if (transaction.status === 'submitted') {
    return {
      ok: false,
      reason: 'already-submitted',
      message: 'This transaction has already been submitted.',
    };
  }

  if (now >= transaction.expiresAt) {
    return {
      ok: false,
      reason: 'expired',
      message: 'Prepared transaction has expired. Please prepare it again.',
    };
  }

  if (transaction.network !== context.network) {
    return {
      ok: false,
      reason: 'network-mismatch',
      message: 'Active network changed since this transaction was prepared.',
    };
  }

  if (transaction.account !== context.account) {
    return {
      ok: false,
      reason: 'account-mismatch',
      message: 'Active account changed since this transaction was prepared.',
    };
  }

  if (transaction.streamVersion !== context.streamVersion) {
    return {
      ok: false,
      reason: 'stale-stream',
      message: 'Stream state changed since this transaction was prepared.',
    };
  }

  return {
    ok: true,
    transaction: { ...transaction, status: 'revalidated' },
  };
}

export interface UseStreamActionsOptions {
  network: string;
  account: string | null;
  streamVersion: number;
  submit: (action: StreamAction) => Promise<void>;
  sign: (transaction: PreparedTransaction) => Promise<void>;
}

export function useStreamActions({
  network,
  account,
  streamVersion,
  submit,
  sign,
}: UseStreamActionsOptions) {
  const [prepared, setPrepared] = useState<PreparedTransaction | null>(null);
  const [error, setError] = useState<string | null>(null);
  const submittingRef = useRef(false);

  // Discard prepared payloads when the account or network changes.
  useEffect(() => {
    setPrepared((current) => {
      if (!current) return current;
      if (current.account !== (account ?? '') || current.network !== network) {
        return null;
      }
      return current;
    });
  }, [account, network]);

  const prepare = useCallback(
    (input: PrepareTransactionInput): PreparedTransaction => {
      const preparedAt = Date.now();
      const transaction: PreparedTransaction = {
        id: nextPreparedId(),
        kind: input.kind,
        payload: input.payload,
        streamId: input.streamId,
        network: input.network,
        account: input.account,
        streamVersion: input.streamVersion,
        preparedAt,
        expiresAt: preparedAt + (input.ttlMs ?? DEFAULT_PREPARED_TTL_MS),
        status: 'prepared',
      };
      setError(null);
      setPrepared(transaction);
      return transaction;
    },
    [],
  );

  const discard = useCallback(() => {
    setPrepared(null);
    setError(null);
  }, []);

  const submitPrepared = useCallback(async () => {
    if (!prepared) {
      setError('No prepared transaction to submit.');
      return;
    }
    if (submittingRef.current) {
      setError('A submission is already in progress.');
      return;
    }

    const result = revalidatePreparedTransaction(prepared, {
      network,
      account: account ?? '',
      streamVersion,
    });

    if (!result.ok) {
      setError(result.message);
      setPrepared((current) =>
        current && current.id === prepared.id
          ? { ...current, status: 'rejected' }
          : current,
      );
      return;
    }

    submittingRef.current = true;
    setError(null);
    setPrepared(result.transaction);

    try {
      await sign(result.transaction);
      await submit({
        kind: result.transaction.kind,
        payload: result.transaction.payload,
        streamId: result.transaction.streamId,
      } as StreamAction);
      setPrepared((current) =>
        current && current.id === result.transaction.id
          ? { ...current, status: 'submitted' }
          : current,
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Submission failed.');
    } finally {
      submittingRef.current = false;
    }
  }, [prepared, network, account, streamVersion, sign, submit]);

  const isSubmitting = useMemo(
    () => prepared?.status === 'revalidated' && submittingRef.current,
    [prepared],
  );

  return {
    prepared,
    error,
    isSubmitting,
    prepare,
    discard,
    submitPrepared,
  };
}
