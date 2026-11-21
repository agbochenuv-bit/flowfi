import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Stream } from "../types/stream";
import { useWallet } from "../hooks/useWallet";
import { useNetwork } from "../hooks/useNetwork";
import { useStreamStore } from "../store/streamStore";
import { prepareTransaction, revalidatePreparedTransaction } from "../lib/transactions";
import type { PreparedTransaction, TransactionAction } from "../lib/transactions";

interface StreamActionsProps {
  stream: Stream;
}

const PREPARED_TTL_MS = 5 * 60 * 1000;

type ActionStatus = "idle" | "prepared" | "revalidated" | "submitted";

export function StreamActions({ stream }: StreamActionsProps) {
  const { address, signTransaction } = useWallet();
  const { chainId } = useNetwork();
  const streamState = useStreamStore((s) => s.streams[stream.id]);

  const [status, setStatus] = useState<ActionStatus>("idle");
  const [prepared, setPrepared] = useState<PreparedTransaction | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  const submittedRef = useRef(false);

  const resetPrepared = useCallback(() => {
    setPrepared(null);
    setStatus("idle");
    submittedRef.current = false;
  }, []);

  // Invalidate prepared payloads on account or network change.
  useEffect(() => {
    resetPrepared();
    setError(null);
  }, [address, chainId, resetPrepared]);

  const prepare = useCallback(
    (action: TransactionAction) => {
      setError(null);
      submittedRef.current = false;
      try {
        const next = prepareTransaction({
          action,
          streamId: stream.id,
          account: address,
          chainId,
          streamState,
          expiresAt: Date.now() + PREPARED_TTL_MS,
        });
        setPrepared(next);
        setStatus("prepared");
      } catch (err) {
        resetPrepared();
        setError(err instanceof Error ? err.message : "Failed to prepare transaction");
      }
    },
    [address, chainId, stream.id, streamState, resetPrepared],
  );

  const submit = useCallback(async () => {
    if (!prepared || pending || submittedRef.current) return;
    setError(null);

    const result = revalidatePreparedTransaction(prepared, {
      account: address,
      chainId,
      streamState,
      now: Date.now(),
    });

    if (!result.ok) {
      resetPrepared();
      setError(result.error);
      return;
    }

    setStatus("revalidated");
    setPending(true);
    submittedRef.current = true;
    try {
      await signTransaction(result.transaction);
      setStatus("submitted");
    } catch (err) {
      submittedRef.current = false;
      setError(err instanceof Error ? err.message : "Failed to submit transaction");
    } finally {
      setPending(false);
    }
  }, [prepared, pending, address, chainId, streamState, signTransaction, resetPrepared]);

  const canSubmit = useMemo(
    () => status === "prepared" && prepared !== null && !pending,
    [status, prepared, pending],
  );

  return (
    <div className="stream-actions">
      <button type="button" onClick={() => prepare("withdraw")} disabled={pending}>
        Prepare Withdraw
      </button>
      <button type="button" onClick={() => prepare("cancel")} disabled={pending}>
        Prepare Cancel
      </button>
      <button type="button" onClick={submit} disabled={!canSubmit}>
        {pending ? "Submitting…" : "Submit"}
      </button>
      {status !== "idle" && <span className="stream-actions__status">Status: {status}</span>}
      {error && <p className="stream-actions__error">{error}</p>}
    </div>
  );
}
