import type { BackendStream } from "@/lib/api-types";
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

export type StreamEventType =
  | "created"
  | "deposit"
  | "withdrawal"
  | "paused"
  | "resumed"
  | "cancelled"
  | "completed";

export interface StreamEventRecord {
  id: string;
  streamId: number;
  type: StreamEventType;
  asset: string;
  assetAddress: string;
  participant: string;
  participantDisplay: string;
  amount: number;
  timestamp: number;
  txHash: string | null;
}

export interface StreamEventFilters {
  types?: StreamEventType[];
  asset?: string;
  participant?: string;
  from?: number | string | Date | null;
  to?: number | string | Date | null;
  search?: string;
  limit?: number;
  cursor?: string | null;
}

export interface StreamEventsPage {
  events: StreamEventRecord[];
  total: number;
  hasMore: boolean;
  nextCursor: string | null;
}

interface BackendStreamEvent {
  id?: string;
  streamId?: number;
  type?: string;
  eventType?: string;
  asset?: string;
  tokenAddress?: string;
  participant?: string;
  sender?: string;
  recipient?: string;
  amount?: number | string;
  timestamp?: number | string;
  createdAt?: number | string;
  txHash?: string | null;
}

interface StreamEventsResponse {
  data?: BackendStreamEvent[];
  events?: BackendStreamEvent[];
  total?: number;
  hasMore?: boolean;
  nextCursor?: string | null;
}

const STREAM_EVENT_TYPES: readonly StreamEventType[] = [
  "created",
  "deposit",
  "withdrawal",
  "paused",
  "resumed",
  "cancelled",
  "completed",
];

const DEFAULT_EVENTS_LIMIT = 25;
const MAX_EVENTS_LIMIT = 100;

function normalizeEventTypes(types: unknown): StreamEventType[] {
  if (!Array.isArray(types)) return [];
  const seen = new Set<StreamEventType>();
  for (const value of types) {
    if (typeof value !== "string") continue;
    const normalized = value.trim().toLowerCase() as StreamEventType;
    if (STREAM_EVENT_TYPES.includes(normalized)) seen.add(normalized);
  }
  return Array.from(seen);
}

function normalizeTimestamp(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  if (value instanceof Date) {
    const time = value.getTime();
    return Number.isFinite(time) ? time : null;
  }
  if (typeof value === "number") {
    return Number.isFinite(value) && value >= 0 ? value : null;
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return null;
    const numeric = Number(trimmed);
    if (Number.isFinite(numeric) && numeric >= 0) return numeric;
    const parsed = Date.parse(trimmed);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function normalizeLimit(limit: unknown): number {
  if (typeof limit !== "number" || !Number.isFinite(limit)) {
    return DEFAULT_EVENTS_LIMIT;
  }
  const floored = Math.floor(limit);
  if (floored <= 0) return DEFAULT_EVENTS_LIMIT;
  return Math.min(floored, MAX_EVENTS_LIMIT);
}

function normalizeText(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function buildStreamEventsParams(filters: StreamEventFilters = {}): URLSearchParams {
  const params = new URLSearchParams();

  const types = normalizeEventTypes(filters.types);
  if (types.length > 0) params.set("type", types.join(","));

  const asset = normalizeText(filters.asset);
  if (asset) params.set("asset", asset);

  const participant = normalizeText(filters.participant);
  if (participant) params.set("participant", participant);

  const from = normalizeTimestamp(filters.from);
  if (from !== null) params.set("from", String(from));

  const to = normalizeTimestamp(filters.to);
  if (to !== null) params.set("to", String(to));

  const search = normalizeText(filters.search);
  if (search) params.set("search", search);

  params.set("limit", String(normalizeLimit(filters.limit)));

  const cursor = normalizeText(filters.cursor);
  if (cursor) params.set("cursor", cursor);

  return params;
}

function mapBackendStreamEvent(event: BackendStreamEvent): StreamEventRecord {
  const rawType = (event.type ?? event.eventType ?? "").toString().toLowerCase();
  const type = (STREAM_EVENT_TYPES as readonly string[]).includes(rawType)
    ? (rawType as StreamEventType)
    : "created";
  const assetAddress = event.asset ?? event.tokenAddress ?? "";
  const participant = event.participant ?? event.sender ?? event.recipient ?? "";
  const timestamp = normalizeTimestamp(event.timestamp ?? event.createdAt) ?? 0;

  return {
    id: event.id ?? `${event.streamId ?? 0}-${type}-${timestamp}`,
    streamId: event.streamId ?? 0,
    type,
    asset: assetAddress ? resolveTokenLabel(assetAddress) : "",
    assetAddress,
    participant,
    participantDisplay: participant ? shortenPublicKey(participant) : "",
    amount: toTokenAmount(event.amount ?? 0),
    timestamp,
    txHash: event.txHash ?? null,
  };
}

export async function fetchStreamEvents(
  filters: StreamEventFilters = {},
  timeoutMs: number = DEFAULT_FETCH_TIMEOUT_MS,
  authToken?: string | null,
): Promise<StreamEventsPage> {
  const endpoints = getStreamsEndpointCandidates();
  const params = buildStreamEventsParams(filters);
  let lastError: Error | null = null;

  for (const endpoint of endpoints) {
    const response = await fetchWithTimeout(
      `${endpoint}/events?${params.toString()}`,
      { headers: authToken ? { Authorization: `Bearer ${authToken}` } : {} },
      timeoutMs,
    );

    if (response.ok) {
      const payload = (await response.json()) as
        | StreamEventsResponse
        | BackendStreamEvent[];
      const rawEvents = Array.isArray(payload)
        ? payload
        : payload.events ?? payload.data ?? [];
      const events = rawEvents.map(mapBackendStreamEvent);
      const total = Array.isArray(payload)
        ? events.length
        : payload.total ?? events.length;
      const hasMore = Array.isArray(payload)
        ? false
        : payload.hasMore ?? Boolean(payload.nextCursor);
      const nextCursor = Array.isArray(payload)
        ? null
        : payload.nextCursor ?? null;

      return { events, total, hasMore, nextCursor };
    }

    if (response.status === 404) {
      lastError = new Error(`Endpoint not found: ${endpoint}`);
      continue;
    }

    lastError = new Error(
      `Failed to fetch stream events (${response.status}) from ${endpoint}`,
    );
  }

  throw lastError ?? new Error("Failed to fetch stream events from backend.");
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
