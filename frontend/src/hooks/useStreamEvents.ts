import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';

/**
 * Parsed activity filters used by the transaction activity explorer.
 *
 * All fields are optional; an empty/undefined value means "no constraint".
 * The explorer keeps these URL-addressable, so this hook treats them as
 * plain data and derives a stable query key from them.
 */
export interface ActivityFilters {
  /** Lifecycle action types (e.g. "created", "claimed", "cancelled"). */
  types?: string[];
  /** Asset identifier (symbol or contract address). */
  asset?: string;
  /** Participant address (sender / recipient). */
  participant?: string;
  /** Inclusive lower bound of the date range (ISO string). */
  from?: string;
  /** Inclusive upper bound of the date range (ISO string). */
  to?: string;
  /** Free-text search across event metadata. */
  search?: string;
  /** Sort direction for the result set. */
  sort?: 'asc' | 'desc';
}

/**
 * A single stream event as returned by the backend events endpoint.
 * Kept intentionally loose so the explorer can render unknown fields.
 */
export interface StreamEvent {
  id: string;
  type: string;
  streamId?: string;
  asset?: string;
  sender?: string;
  recipient?: string;
  amount?: string;
  timestamp: string;
  [key: string]: unknown;
}

export interface StreamEventsPage {
  events: StreamEvent[];
  nextCursor: string | null;
  hasMore: boolean;
}

export interface UseStreamEventsOptions {
  /** Connected wallet address. When absent, no request is made. */
  walletAddress?: string | null;
  /** Active network identifier; part of the query key to preserve context. */
  network?: string | null;
  /** Parsed activity filters. */
  filters?: ActivityFilters;
  /** Opaque pagination cursor from a previous page. */
  cursor?: string | null;
  /** Page size. Defaults to the backend default when omitted. */
  limit?: number;
  /** Base URL for the backend API. Defaults to a relative path. */
  baseUrl?: string;
  /** Disable the query entirely (e.g. while filters are invalid). */
  enabled?: boolean;
}

export interface UseStreamEventsResult {
  events: StreamEvent[];
  /** Cursor to request the next page, or null when exhausted. */
  nextCursor: string | null;
  /** Whether more pages are available. */
  hasMore: boolean;
  /** True while a request is in flight (including refetches). */
  isLoading: boolean;
  /** True only for the initial load of the current key. */
  isInitialLoading: boolean;
  /** True while fetching a subsequent page or refetch. */
  isFetching: boolean;
  /** Normalized error, or null. */
  error: Error | null;
  /** True when the request succeeded but returned no events. */
  isEmpty: boolean;
  /** Manually refetch the current page. */
  refetch: () => void;
}

const DEFAULT_BASE_URL = '/api';

/**
 * Normalize filters into a stable, serializable shape so the query key does
 * not change identity on every render (e.g. array reordering, undefined vs
 * empty string).
 */
function normalizeFilters(filters?: ActivityFilters): ActivityFilters {
  if (!filters) return {};
  const normalized: ActivityFilters = {};

  if (filters.types && filters.types.length > 0) {
    normalized.types = Array.from(new Set(filters.types)).sort();
  }
  if (filters.asset) normalized.asset = filters.asset.trim();
  if (filters.participant) normalized.participant = filters.participant.trim();
  if (filters.from) normalized.from = filters.from;
  if (filters.to) normalized.to = filters.to;
  if (filters.search) normalized.search = filters.search.trim();
  if (filters.sort) normalized.sort = filters.sort;

  return normalized;
}

/**
 * Build the query string for the backend events endpoint. Empty values are
 * omitted so the URL stays canonical and cache-friendly.
 */
function buildQueryString(
  filters: ActivityFilters,
  cursor: string | null | undefined,
  limit: number | undefined,
): string {
  const params = new URLSearchParams();

  if (filters.types && filters.types.length > 0) {
    params.set('types', filters.types.join(','));
  }
  if (filters.asset) params.set('asset', filters.asset);
  if (filters.participant) params.set('participant', filters.participant);
  if (filters.from) params.set('from', filters.from);
  if (filters.to) params.set('to', filters.to);
  if (filters.search) params.set('search', filters.search);
  if (filters.sort) params.set('sort', filters.sort);
  if (cursor) params.set('cursor', cursor);
  if (typeof limit === 'number' && Number.isFinite(limit) && limit > 0) {
    params.set('limit', String(limit));
  }

  const qs = params.toString();
  return qs ? `?${qs}` : '';
}

/**
 * Coerce an unknown backend payload into a StreamEventsPage. Tolerates a few
 * common response shapes so the explorer stays resilient to contract drift.
 */
function parsePage(payload: unknown): StreamEventsPage {
  if (!payload || typeof payload !== 'object') {
    return { events: [], nextCursor: null, hasMore: false };
  }

  const record = payload as Record<string, unknown>;
  const rawEvents = Array.isArray(record.events)
    ? record.events
    : Array.isArray(record.data)
      ? record.data
      : Array.isArray(record.items)
        ? record.items
        : [];

  const events = rawEvents.filter(
    (item): item is StreamEvent =>
      !!item && typeof item === 'object' && typeof (item as StreamEvent).id === 'string',
  );

  const nextCursor =
    typeof record.nextCursor === 'string'
      ? record.nextCursor
      : typeof record.next_cursor === 'string'
        ? record.next_cursor
        : null;

  const hasMore =
    typeof record.hasMore === 'boolean'
      ? record.hasMore
      : typeof record.has_more === 'boolean'
        ? record.has_more
        : nextCursor !== null;

  return { events, nextCursor, hasMore };
}

async function fetchStreamEvents(
  url: string,
  signal: AbortSignal,
): Promise<StreamEventsPage> {
  const response = await fetch(url, {
    method: 'GET',
    headers: { Accept: 'application/json' },
    signal,
    credentials: 'same-origin',
  });

  if (!response.ok) {
    let message = `Failed to load stream events (${response.status})`;
    try {
      const body = (await response.json()) as { message?: string; error?: string };
      if (body?.message) message = body.message;
      else if (body?.error) message = body.error;
    } catch {
      // Ignore body parse failures; keep the status-based message.
    }
    const error = new Error(message);
    (error as Error & { status?: number }).status = response.status;
    throw error;
  }

  const payload = (await response.json()) as unknown;
  return parsePage(payload);
}

/**
 * Fetch a paginated page of stream events for the connected wallet.
 *
 * - The query key includes the active network so switching networks never
 *   serves stale events from another chain.
 * - In-flight requests are cancelled when filters, cursor, wallet, or network
 *   change (via AbortSignal wired through react-query).
 * - Exposes loading / error / empty states plus `nextCursor` / `hasMore` so
 *   the explorer can paginate stably.
 */
export function useStreamEvents(
  options: UseStreamEventsOptions = {},
): UseStreamEventsResult {
  const {
    walletAddress,
    network,
    filters,
    cursor,
    limit,
    baseUrl = DEFAULT_BASE_URL,
    enabled = true,
  } = options;

  const normalizedFilters = useMemo(() => normalizeFilters(filters), [filters]);

  const queryString = useMemo(
    () => buildQueryString(normalizedFilters, cursor, limit),
    [normalizedFilters, cursor, limit],
  );

  const requestUrl = useMemo(() => {
    if (!walletAddress) return null;
    const trimmedBase = baseUrl.replace(/\/+$/, '');
    return `${trimmedBase}/wallets/${encodeURIComponent(walletAddress)}/events${queryString}`;
  }, [baseUrl, walletAddress, queryString]);

  const queryKey = useMemo(
    () =>
      [
        'stream-events',
        network ?? null,
        walletAddress ?? null,
        normalizedFilters,
        cursor ?? null,
        limit ?? null,
      ] as const,
    [network, walletAddress, normalizedFilters, cursor, limit],
  );

  const isEnabled = enabled && !!walletAddress && !!requestUrl;

  const query = useQuery<StreamEventsPage, Error>({
    queryKey,
    queryFn: ({ signal }) => {
      if (!requestUrl) {
        return Promise.resolve({ events: [], nextCursor: null, hasMore: false });
      }
      return fetchStreamEvents(requestUrl, signal);
    },
    enabled: isEnabled,
    // Pagination is cursor-based and stable; avoid aggressive refetching that
    // would shift pages under the user.
    staleTime: 30_000,
    refetchOnWindowFocus: false,
    retry: (failureCount, error) => {
      const status = (error as Error & { status?: number }).status;
      // Do not retry client errors (bad filters, unauthorized, not found).
      if (status && status >= 400 && status < 500) return false;
      return failureCount < 2;
    },
  });

  // Track whether we've ever resolved data for the current key so we can
  // distinguish "initial loading" from background refetches.
  const [hasResolved, setHasResolved] = useState(false);
  const lastKeyRef = useRef<string>('');

  const serializedKey = JSON.stringify(queryKey);

  useEffect(() => {
    if (lastKeyRef.current !== serializedKey) {
      lastKeyRef.current = serializedKey;
      setHasResolved(false);
    }
  }, [serializedKey]);

  useEffect(() => {
    if (query.isSuccess && !hasResolved) {
      setHasResolved(true);
    }
  }, [query.isSuccess, hasResolved]);

  const refetch = useCallback(() => {
    void query.refetch();
  }, [query]);

  const events = query.data?.events ?? [];
  const nextCursor = query.data?.nextCursor ?? null;
  const hasMore = query.data?.hasMore ?? false;

  const isInitialLoading = isEnabled && !hasResolved && (query.isLoading || query.isFetching);

  return {
    events,
    nextCursor,
    hasMore,
    isLoading: isEnabled && (query.isLoading || query.isFetching),
    isInitialLoading,
    isFetching: query.isFetching,
    error: query.error ?? null,
    isEmpty: query.isSuccess && events.length === 0,
    refetch,
  };
}

export default useStreamEvents;