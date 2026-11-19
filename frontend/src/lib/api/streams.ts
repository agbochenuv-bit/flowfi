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
 * Stable error code returned by the backend when a mutation is rejected
 * because the stream changed after the client reviewed it.
 */
export const STREAM_VERSION_CONFLICT_CODE = "STREAM_VERSION_CONFLICT" as const;

/**
 * Payload returned alongside a 409 response for stale stream mutations.
 * `currentVersion` is the version the client must re-read before retrying.
 */
export interface StreamVersionConflict {
  code: typeof STREAM_VERSION_CONFLICT_CODE;
  message: string;
  streamId: number;
  expectedVersion: number;
  currentVersion: number;
  currentLastUpdateTime?: number;
}

/**
 * Thrown by mutation helpers when the backend reports a version conflict.
 * Callers can catch this to refresh the stream and re-prompt the user.
 */
export class StreamVersionConflictError extends Error {
  readonly conflict: StreamVersionConflict;

  constructor(conflict: StreamVersionConflict) {
    super(conflict.message);
    this.name = "StreamVersionConflictError";
    this.conflict = conflict;
  }
}

export type ReadinessSeverity = "blocker" | "warning";

export interface ReadinessCheck {
  code: string;
  severity: ReadinessSeverity;
  message: string;
}

export interface StreamReadiness {
  streamId: number;
  action: string;
  ready: boolean;
  version: number;
  checkedAt: number;
  blockers: ReadinessCheck[];
  warnings: ReadinessCheck[];
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

function isVersionConflictPayload(value: unknown): value is StreamVersionConflict {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<StreamVersionConflict>;
  return (
    candidate.code === STREAM_VERSION_CONFLICT_CODE &&
    typeof candidate.streamId === "number" &&
    typeof candidate.expectedVersion === "number" &&
    typeof candidate.currentVersion === "number"
  );
}

async function parseVersionConflict(
  response: Response,
  fallback: { streamId: number; expectedVersion: number },
): Promise<StreamVersionConflictError> {
  let payload: unknown = null;
  try {
    payload = await response.json();
  } catch {
    payload = null;
  }

  const conflict: StreamVersionConflict = isVersionConflictPayload(payload)
    ? payload
    : {
        code: STREAM_VERSION_CONFLICT_CODE,
        message: "Stream changed since it was reviewed. Refresh and retry.",
        streamId: fallback.streamId,
        expectedVersion: fallback.expectedVersion,
        currentVersion: -1,
      };

  return new StreamVersionConflictError(conflict);
}

export interface StreamMutationOptions {
  /** Version the client reviewed; sent as `expectedVersion` for optimistic concurrency. */
  expectedVersion: number;
  authToken?: string | null;
  timeoutMs?: number;
}

/**
 * Submit a stream mutation with optimistic concurrency control.
 *
 * The wallet-signed transaction is still required and validated server-side;
 * `expectedVersion` only guards against acting on stale state. A 409 response
 * is surfaced as a {@link StreamVersionConflictError} carrying the current
 * version metadata so callers can refresh and retry.
 */
export async function submitStreamMutation(
  streamId: number,
  action: string,
  signedTransactionXdr: string,
  options: StreamMutationOptions,
): Promise<unknown> {
  const endpoints = getStreamsEndpointCandidates();
  const endpoint = endpoints[0];
  const timeoutMs = options.timeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS;

  const response = await fetchWithTimeout(
    `${endpoint}/${streamId}/${action}`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(options.authToken
          ? { Authorization: `Bearer ${options.authToken}` }
          : {}),
      },
      body: JSON.stringify({
        signedTransactionXdr,
        expectedVersion: options.expectedVersion,
      }),
    },
    timeoutMs,
  );

  if (response.status === 409) {
    throw await parseVersionConflict(response, {
      streamId,
      expectedVersion: options.expectedVersion,
    });
  }

  if (!response.ok) {
    throw new Error(
      `Stream mutation failed (${response.status}) for ${action} on ${streamId}`,
    );
  }

  return response.json();
}

/**
 * Fetch machine-readable preflight readiness for a stream action.
 *
 * Results are advisory only: `ready === true` does not guarantee the
 * transaction will succeed, since state can change between the check and the
 * signed submission. Blockers must be resolved; warnings are informational.
 */
export async function fetchStreamReadiness(
  streamId: number,
  action: string,
  options: { authToken?: string | null; timeoutMs?: number } = {},
): Promise<StreamReadiness> {
  const endpoints = getStreamsEndpointCandidates();
  const endpoint = endpoints[0];
  const timeoutMs = options.timeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS;
  const params = new URLSearchParams({ action });

  const response = await fetchWithTimeout(
    `${endpoint}/${streamId}/readiness?${params.toString()}`,
    { headers: options.authToken ? { Authorization: `Bearer ${options.authToken}` } : {} },
    timeoutMs,
  );

  if (!response.ok) {
    throw new Error(
      `Failed to fetch readiness (${response.status}) for ${action} on ${streamId}`,
    );
  }

  const payload = (await response.json()) as Partial<StreamReadiness>;
  return {
    streamId: payload.streamId ?? streamId,
    action: payload.action ?? action,
    ready: payload.ready ?? false,
    version: payload.version ?? -1,
    checkedAt: payload.checkedAt ?? Date.now(),
    blockers: payload.blockers ?? [],
    warnings: payload.warnings ?? [],
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
