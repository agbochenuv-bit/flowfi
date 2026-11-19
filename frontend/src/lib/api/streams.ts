import type {
  BackendStream,
  RecurringSchedule,
  RecurringScheduleCreateRequest,
  ScheduleFundingPreview,
  ScheduleRun,
} from "@/lib/api-types";
import { TOKEN_ADDRESSES } from "@/lib/soroban";
import { shortenPublicKey } from "@/lib/wallet";
import {
  DEFAULT_FETCH_TIMEOUT_MS,
  fetchWithTimeout,
  getStreamsEndpointCandidates,
  toTokenAmount,
} from "@/lib/api/_shared";

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

// ---------------------------------------------------------------------------
// Recurring payment schedules
// ---------------------------------------------------------------------------

export interface RecurringScheduleRecord {
  id: string;
  scheduleId: number;
  sender: string;
  senderDisplay: string;
  recipient: string;
  recipientDisplay: string;
  token: string;
  tokenAddress: string;
  amountPerRun: number;
  intervalSeconds: number;
  nextRunAt: number;
  remainingRuns: number;
  status: RecurringSchedule["status"];
  /** Each generated stream is tracked as its own payment obligation. */
  runs: ScheduleRun[];
  createdAt: number;
  updatedAt: number;
}

export interface ScheduleFundingPreviewRecord {
  scheduleId: number;
  token: string;
  tokenAddress: string;
  requiredAmount: number;
  availableBalance: number;
  shortfall: number;
  sufficient: boolean;
  nextRunAt: number;
  checkedAt: number;
}

interface ScheduleListResponse {
  data?: RecurringSchedule[];
}

interface ScheduleFundingPreviewResponse {
  data?: ScheduleFundingPreview;
}

function resolveScheduleEndpointCandidates(): string[] {
  return getStreamsEndpointCandidates().map((endpoint) =>
    endpoint.replace(/\/streams\/?$/, "/schedules"),
  );
}

function mapScheduleRun(run: ScheduleRun): ScheduleRun {
  return {
    ...run,
    amount: toTokenAmount(run.amount),
  };
}

function mapRecurringSchedule(schedule: RecurringSchedule): RecurringScheduleRecord {
  return {
    id: schedule.id,
    scheduleId: schedule.scheduleId,
    sender: schedule.sender,
    senderDisplay: shortenPublicKey(schedule.sender),
    recipient: schedule.recipient,
    recipientDisplay: shortenPublicKey(schedule.recipient),
    token: resolveTokenLabel(schedule.tokenAddress),
    tokenAddress: schedule.tokenAddress,
    amountPerRun: toTokenAmount(schedule.amountPerRun),
    intervalSeconds: schedule.intervalSeconds,
    nextRunAt: schedule.nextRunAt,
    remainingRuns: schedule.remainingRuns,
    status: schedule.status,
    runs: (schedule.runs ?? []).map(mapScheduleRun),
    createdAt: schedule.createdAt,
    updatedAt: schedule.updatedAt,
  };
}

function mapFundingPreview(
  preview: ScheduleFundingPreview,
): ScheduleFundingPreviewRecord {
  return {
    scheduleId: preview.scheduleId,
    token: resolveTokenLabel(preview.tokenAddress),
    tokenAddress: preview.tokenAddress,
    requiredAmount: toTokenAmount(preview.requiredAmount),
    availableBalance: toTokenAmount(preview.availableBalance),
    shortfall: toTokenAmount(preview.shortfall),
    sufficient: preview.sufficient,
    nextRunAt: preview.nextRunAt,
    checkedAt: preview.checkedAt,
  };
}

async function requestScheduleEndpoint<T>(
  path: string,
  init: RequestInit,
  timeoutMs: number,
  authToken?: string | null,
): Promise<T> {
  const endpoints = resolveScheduleEndpointCandidates();
  let lastError: Error | null = null;

  for (const endpoint of endpoints) {
    const response = await fetchWithTimeout(
      `${endpoint}${path}`,
      {
        ...init,
        headers: {
          ...(init.body ? { "Content-Type": "application/json" } : {}),
          ...(authToken ? { Authorization: `Bearer ${authToken}` } : {}),
          ...(init.headers ?? {}),
        },
      },
      timeoutMs,
    );

    if (response.ok) {
      return (await response.json()) as T;
    }

    if (response.status === 404) {
      lastError = new Error(`Endpoint not found: ${endpoint}${path}`);
      continue;
    }

    lastError = new Error(
      `Schedule request failed (${response.status}) from ${endpoint}${path}`,
    );
  }

  throw lastError ?? new Error("Failed to reach schedule backend.");
}

export async function fetchRecurringSchedules(
  ownerPublicKey: string,
  timeoutMs: number = DEFAULT_FETCH_TIMEOUT_MS,
  authToken?: string | null,
): Promise<RecurringScheduleRecord[]> {
  const params = new URLSearchParams({
    owner: ownerPublicKey,
    sort: "nextRunAt",
    order: "asc",
    limit: "100",
  });
  const payload = await requestScheduleEndpoint<
    RecurringSchedule[] | ScheduleListResponse
  >(`?${params.toString()}`, { method: "GET" }, timeoutMs, authToken);
  const schedules = Array.isArray(payload) ? payload : payload.data ?? [];
  return schedules.map(mapRecurringSchedule);
}

export async function createRecurringSchedule(
  request: RecurringScheduleCreateRequest,
  timeoutMs: number = DEFAULT_FETCH_TIMEOUT_MS,
  authToken?: string | null,
): Promise<RecurringScheduleRecord> {
  const payload = await requestScheduleEndpoint<RecurringSchedule>(
    "",
    { method: "POST", body: JSON.stringify(request) },
    timeoutMs,
    authToken,
  );
  return mapRecurringSchedule(payload);
}

export async function pauseRecurringSchedule(
  scheduleId: number,
  timeoutMs: number = DEFAULT_FETCH_TIMEOUT_MS,
  authToken?: string | null,
): Promise<RecurringScheduleRecord> {
  const payload = await requestScheduleEndpoint<RecurringSchedule>(
    `/${scheduleId}/pause`,
    { method: "POST" },
    timeoutMs,
    authToken,
  );
  return mapRecurringSchedule(payload);
}

export async function cancelRecurringSchedule(
  scheduleId: number,
  timeoutMs: number = DEFAULT_FETCH_TIMEOUT_MS,
  authToken?: string | null,
): Promise<RecurringScheduleRecord> {
  const payload = await requestScheduleEndpoint<RecurringSchedule>(
    `/${scheduleId}/cancel`,
    { method: "POST" },
    timeoutMs,
    authToken,
  );
  return mapRecurringSchedule(payload);
}

export async function fetchScheduleFundingPreview(
  scheduleId: number,
  timeoutMs: number = DEFAULT_FETCH_TIMEOUT_MS,
  authToken?: string | null,
): Promise<ScheduleFundingPreviewRecord> {
  const payload = await requestScheduleEndpoint<
    ScheduleFundingPreview | ScheduleFundingPreviewResponse
  >(`/${scheduleId}/funding-preview`, { method: "GET" }, timeoutMs, authToken);
  const preview = "data" in payload && payload.data ? payload.data : payload;
  return mapFundingPreview(preview as ScheduleFundingPreview);
}
