import type { BackendStream } from "@/lib/api-types";
import { TOKEN_ADDRESSES } from "@/lib/soroban";
import { shortenPublicKey } from "@/lib/wallet";
import {
  DEFAULT_FETCH_TIMEOUT_MS,
  fetchWithTimeout,
  getStreamsEndpointCandidates,
  toTokenAmount,
} from "@/lib/api/_shared";

/**
 * Non-secret recovery metadata returned when a stream creation is submitted.
 *
 * This is intentionally limited to public identifiers and amounts so it can be
 * persisted by the transaction center and used to resume/inspect a submission
 * after a reload. It must never contain private keys, signed XDR, or auth tokens.
 */
export interface StreamCreationRecoveryMetadata {
  /** Client-generated idempotency key used to dedupe submissions. */
  idempotencyKey: string;
  /** On-chain transaction hash, when the backend has already broadcast it. */
  transactionHash: string | null;
  /** Backend stream id, when the stream record has been created. */
  streamId: string | null;
  /** Recipient public key (public, non-secret). */
  recipient: string;
  /** Token contract address (public, non-secret). */
  tokenAddress: string;
  /** Total deposited amount as a decimal string. */
  depositedAmount: string;
  /** Ledger timestamp at which the submission was accepted. */
  submittedAt: number;
}

export interface SubmitStreamCreationParams {
  recipient: string;
  tokenAddress: string;
  depositedAmount: string;
  /** Optional client-generated idempotency key. Generated when omitted. */
  idempotencyKey?: string;
  authToken?: string | null;
  timeoutMs?: number;
}

export interface SubmitStreamCreationResult {
  transactionHash: string | null;
  streamId: string | null;
  recovery: StreamCreationRecoveryMetadata;
}

/**
 * In-flight idempotency keys. Prevents duplicate submissions from firing a
 * second network request while the first is still pending.
 */
const inFlightIdempotencyKeys = new Set<string>();

export class DuplicateSubmissionError extends Error {
  constructor(public readonly idempotencyKey: string) {
    super(`Duplicate stream submission for idempotency key: ${idempotencyKey}`);
    this.name = "DuplicateSubmissionError";
  }
}

function generateIdempotencyKey(): string {
  const cryptoObj = globalThis.crypto;
  if (cryptoObj && typeof cryptoObj.randomUUID === "function") {
    return cryptoObj.randomUUID();
  }
  // Fallback for environments without crypto.randomUUID.
  return `idem-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function resolveStreamsBaseEndpoint(): string {
  const [endpoint] = getStreamsEndpointCandidates();
  if (!endpoint) {
    throw new Error("No streams endpoint configured.");
  }
  return endpoint;
}

/**
 * Submits a stream creation request to the backend.
 *
 * Duplicate submissions sharing the same idempotency key are rejected
 * client-side (before any network call) with a {@link DuplicateSubmissionError}.
 * The returned recovery metadata contains only non-secret fields.
 */
export async function submitStreamCreation(
  params: SubmitStreamCreationParams,
): Promise<SubmitStreamCreationResult> {
  const idempotencyKey = params.idempotencyKey ?? generateIdempotencyKey();

  if (inFlightIdempotencyKeys.has(idempotencyKey)) {
    throw new DuplicateSubmissionError(idempotencyKey);
  }

  inFlightIdempotencyKeys.add(idempotencyKey);

  try {
    const endpoint = resolveStreamsBaseEndpoint();
    const response = await fetchWithTimeout(
      endpoint,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": idempotencyKey,
          ...(params.authToken
            ? { Authorization: `Bearer ${params.authToken}` }
            : {}),
        },
        body: JSON.stringify({
          recipient: params.recipient,
          tokenAddress: params.tokenAddress,
          depositedAmount: params.depositedAmount,
        }),
      },
      params.timeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS,
    );

    if (!response.ok) {
      throw new Error(
        `Failed to submit stream creation (${response.status}) from ${endpoint}`,
      );
    }

    const payload = (await response.json()) as {
      transactionHash?: string | null;
      streamId?: string | null;
    };

    const transactionHash = payload.transactionHash ?? null;
    const streamId = payload.streamId ?? null;

    return {
      transactionHash,
      streamId,
      recovery: {
        idempotencyKey,
        transactionHash,
        streamId,
        recipient: params.recipient,
        tokenAddress: params.tokenAddress,
        depositedAmount: params.depositedAmount,
        submittedAt: Date.now(),
      },
    };
  } finally {
    inFlightIdempotencyKeys.delete(idempotencyKey);
  }
}

export type IncomingStreamStatus = "Active" | "Paused" | "Completed";

export interface IncomingStreamRecord {
  id: string;
  streamId: number;
  sender: string;
  senderDisplay: string;
  token: string;
  tokenAddress: string;
  ratePerSecond: number;
  deposited: number;
  withdrawn: number;
  startTime: number;
  lastUpdateTime: number;
  isActive: boolean;
  isPaused: boolean;
  pausedAt: number | null;
  totalPausedDuration: number;
  status: IncomingStreamStatus;
}

interface StreamListResponse {
  data?: BackendStream[];
}

function resolveTokenLabel(tokenAddress: string): string {
  const entry = Object.entries(TOKEN_ADDRESSES).find(
    ([, address]) => address === tokenAddress,
  );

  return entry?.[0] ?? `${tokenAddress.slice(0, 6)}...${tokenAddress.slice(-4)}`;
}

function toIncomingStreamStatus(stream: BackendStream): IncomingStreamStatus {
  if (stream.isPaused) return "Paused";
  if (stream.isActive) return "Active";
  return "Completed";
}

function mapBackendStream(stream: BackendStream): IncomingStreamRecord {
  return {
    id: stream.id,
    streamId: stream.streamId,
    sender: stream.sender,
    senderDisplay: shortenPublicKey(stream.sender),
    token: resolveTokenLabel(stream.tokenAddress),
    tokenAddress: stream.tokenAddress,
    ratePerSecond: toTokenAmount(stream.ratePerSecond),
    deposited: toTokenAmount(stream.depositedAmount),
    withdrawn: toTokenAmount(stream.withdrawnAmount),
    startTime: stream.startTime,
    lastUpdateTime: stream.lastUpdateTime,
    isActive: stream.isActive,
    isPaused: stream.isPaused ?? false,
    pausedAt: stream.pausedAt ?? null,
    totalPausedDuration: stream.totalPausedDuration ?? 0,
    status: toIncomingStreamStatus(stream),
  };
}

export async function fetchIncomingStreams(
  recipientPublicKey: string,
  timeoutMs: number = DEFAULT_FETCH_TIMEOUT_MS,
  authToken?: string | null,
): Promise<IncomingStreamRecord[]> {
  const endpoints = getStreamsEndpointCandidates();
  const params = new URLSearchParams({
    recipient: recipientPublicKey,
    sort: "lastUpdateTime",
    order: "desc",
    limit: "100",
  });
  let lastError: Error | null = null;

  for (const endpoint of endpoints) {
    const response = await fetchWithTimeout(
      `${endpoint}?${params.toString()}`,
      { headers: authToken ? { Authorization: `Bearer ${authToken}` } : {} },
      timeoutMs,
    );

    if (response.ok) {
      const payload = (await response.json()) as BackendStream[] | StreamListResponse;
      const streams = Array.isArray(payload) ? payload : payload.data ?? [];
      return streams.map(mapBackendStream);
    }

    if (response.status === 404) {
      lastError = new Error(`Endpoint not found: ${endpoint}`);
      continue;
    }

    lastError = new Error(
      `Failed to fetch incoming streams (${response.status}) from ${endpoint}`,
    );
  }

  throw lastError ?? new Error("Failed to fetch incoming streams from backend.");
}
