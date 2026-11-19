import type { BackendStreamEvent, StreamEventType } from "@/lib/api-types";

/**
 * Pure filtering/sorting helpers for the activity history table (issue #1328).
 *
 * Kept UI-free so the multi-parameter filter logic can be unit-tested without
 * a DOM and reused by both the dashboard widget and the full activity page.
 */

export interface ActivityFilters {
  /** Event types to keep. `null`/empty means "all types". */
  types?: StreamEventType[] | null;
  /** Case-insensitive substring match against tx hash or stream id. */
  search?: string;
  /** Inclusive lower bound, unix seconds. */
  fromTimestamp?: number | null;
  /** Inclusive upper bound, unix seconds. */
  toTimestamp?: number | null;
  /** Asset code to keep (case-insensitive exact match). `null` means "all". */
  asset?: string | null;
  /** Participant address to keep (case-insensitive exact match). */
  participant?: string | null;
  /** Lifecycle action to keep (case-insensitive exact match). */
  lifecycleAction?: string | null;
}

export type ActivitySortKey = "timestamp" | "amount" | "streamId";
export type SortDirection = "asc" | "desc";

/**
 * Full URL-addressable filter state: the composable filter dimensions plus
 * pagination state. This is the shape that round-trips through the query
 * string so filters survive reloads and browser back/forward navigation.
 */
export interface ActivityFiltersState extends ActivityFilters {
  /** 1-based page number. Defaults to 1. */
  page: number;
  /** Opaque cursor for cursor-based pagination. `null` means "start". */
  cursor: string | null;
  /** Page size. Defaults to {@link DEFAULT_ACTIVITY_PAGE_SIZE}. */
  pageSize: number;
}

export const DEFAULT_ACTIVITY_PAGE_SIZE = 20;

/** Query-string keys used by {@link serializeActivityFiltersToSearchParams}. */
export const ACTIVITY_FILTER_PARAM_KEYS = {
  types: "types",
  search: "q",
  fromTimestamp: "from",
  toTimestamp: "to",
  asset: "asset",
  participant: "participant",
  lifecycleAction: "action",
  page: "page",
  cursor: "cursor",
  pageSize: "pageSize",
} as const;

/** The default state used when no (valid) query params are present. */
export function defaultActivityFiltersState(): ActivityFiltersState {
  return {
    types: null,
    search: "",
    fromTimestamp: null,
    toTimestamp: null,
    asset: null,
    participant: null,
    lifecycleAction: null,
    page: 1,
    cursor: null,
    pageSize: DEFAULT_ACTIVITY_PAGE_SIZE,
  };
}

function parsePositiveInt(raw: string | null): number | null {
  if (raw == null) return null;
  const trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed)) return null;
  const value = Number.parseInt(trimmed, 10);
  return Number.isSafeInteger(value) && value > 0 ? value : null;
}

function parseTimestamp(raw: string | null): number | null {
  if (raw == null) return null;
  const trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed)) return null;
  const value = Number.parseInt(trimmed, 10);
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function parseNonEmptyString(raw: string | null): string | null {
  if (raw == null) return null;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function parseTypes(raw: string | null): StreamEventType[] | null {
  if (raw == null) return null;
  const parts = raw
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
  return parts.length > 0 ? (parts as StreamEventType[]) : null;
}

/**
 * Parse filter + pagination state from a query string. Never throws: any
 * missing or invalid value falls back to its default, so a hand-edited or
 * stale URL cannot break the page.
 */
export function parseActivityFiltersFromSearchParams(
  searchParams: URLSearchParams,
): ActivityFiltersState {
  const defaults = defaultActivityFiltersState();
  const keys = ACTIVITY_FILTER_PARAM_KEYS;

  const fromTimestamp = parseTimestamp(searchParams.get(keys.fromTimestamp));
  const toTimestamp = parseTimestamp(searchParams.get(keys.toTimestamp));

  // Normalize an inverted range by swapping so the filter stays usable.
  const normalizedFrom =
    fromTimestamp != null && toTimestamp != null && fromTimestamp > toTimestamp
      ? toTimestamp
      : fromTimestamp;
  const normalizedTo =
    fromTimestamp != null && toTimestamp != null && fromTimestamp > toTimestamp
      ? fromTimestamp
      : toTimestamp;

  return {
    types: parseTypes(searchParams.get(keys.types)),
    search: parseNonEmptyString(searchParams.get(keys.search)) ?? "",
    fromTimestamp: normalizedFrom,
    toTimestamp: normalizedTo,
    asset: parseNonEmptyString(searchParams.get(keys.asset)),
    participant: parseNonEmptyString(searchParams.get(keys.participant)),
    lifecycleAction: parseNonEmptyString(searchParams.get(keys.lifecycleAction)),
    page: parsePositiveInt(searchParams.get(keys.page)) ?? defaults.page,
    cursor: parseNonEmptyString(searchParams.get(keys.cursor)),
    pageSize:
      parsePositiveInt(searchParams.get(keys.pageSize)) ?? defaults.pageSize,
  };
}

/**
 * Serialize filter + pagination state to a query string. Defaults are omitted
 * so URLs stay short and shareable; the output round-trips through
 * {@link parseActivityFiltersFromSearchParams}.
 */
export function serializeActivityFiltersToSearchParams(
  state: Partial<ActivityFiltersState>,
): URLSearchParams {
  const defaults = defaultActivityFiltersState();
  const keys = ACTIVITY_FILTER_PARAM_KEYS;
  const params = new URLSearchParams();

  const types = state.types?.filter((t) => typeof t === "string" && t.length > 0);
  if (types && types.length > 0) params.set(keys.types, types.join(","));

  const search = state.search?.trim();
  if (search) params.set(keys.search, search);

  if (state.fromTimestamp != null) {
    params.set(keys.fromTimestamp, String(state.fromTimestamp));
  }
  if (state.toTimestamp != null) {
    params.set(keys.toTimestamp, String(state.toTimestamp));
  }

  const asset = state.asset?.trim();
  if (asset) params.set(keys.asset, asset);

  const participant = state.participant?.trim();
  if (participant) params.set(keys.participant, participant);

  const lifecycleAction = state.lifecycleAction?.trim();
  if (lifecycleAction) params.set(keys.lifecycleAction, lifecycleAction);

  if (state.page != null && state.page !== defaults.page) {
    params.set(keys.page, String(state.page));
  }
  if (state.cursor) params.set(keys.cursor, state.cursor);
  if (state.pageSize != null && state.pageSize !== defaults.pageSize) {
    params.set(keys.pageSize, String(state.pageSize));
  }

  return params;
}

/**
 * Compare two filter states ignoring pagination. Used to decide whether a
 * filter change should reset the cursor/page back to the start.
 */
export function activityFiltersEqual(
  a: Partial<ActivityFiltersState>,
  b: Partial<ActivityFiltersState>,
): boolean {
  const norm = (s: Partial<ActivityFiltersState>) => ({
    types: [...(s.types ?? [])].sort().join(","),
    search: (s.search ?? "").trim().toLowerCase(),
    fromTimestamp: s.fromTimestamp ?? null,
    toTimestamp: s.toTimestamp ?? null,
    asset: (s.asset ?? "").trim().toLowerCase(),
    participant: (s.participant ?? "").trim().toLowerCase(),
    lifecycleAction: (s.lifecycleAction ?? "").trim().toLowerCase(),
  });
  const na = norm(a);
  const nb = norm(b);
  return (
    na.types === nb.types &&
    na.search === nb.search &&
    na.fromTimestamp === nb.fromTimestamp &&
    na.toTimestamp === nb.toTimestamp &&
    na.asset === nb.asset &&
    na.participant === nb.participant &&
    na.lifecycleAction === nb.lifecycleAction
  );
}

/**
 * Return `next` with pagination reset to the first page when any filter
 * dimension changed relative to `prev`. When only pagination changed, the
 * incoming pagination state is preserved so paging stays stable.
 */
export function resetCursorOnFilterChange(
  prev: Partial<ActivityFiltersState>,
  next: Partial<ActivityFiltersState>,
): ActivityFiltersState {
  const defaults = defaultActivityFiltersState();
  const merged: ActivityFiltersState = {
    ...defaults,
    ...prev,
    ...next,
  };
  if (activityFiltersEqual(prev, next)) return merged;
  return { ...merged, page: 1, cursor: null };
}

function matchesSearch(event: BackendStreamEvent, needle: string): boolean {
  const q = needle.trim().toLowerCase();
  if (!q) return true;
  return (
    event.transactionHash.toLowerCase().includes(q) ||
    String(event.streamId).includes(q)
  );
}

/** Apply every provided filter. Filters left undefined are ignored. */
export function filterActivityEvents(
  events: BackendStreamEvent[],
  filters: ActivityFilters = {},
): BackendStreamEvent[] {
  const typeSet =
    filters.types && filters.types.length > 0 ? new Set(filters.types) : null;

  const assetNeedle = filters.asset?.trim().toLowerCase() || null;
  const participantNeedle = filters.participant?.trim().toLowerCase() || null;
  const lifecycleNeedle =
    filters.lifecycleAction?.trim().toLowerCase() || null;

  return events.filter((event) => {
    if (typeSet && !typeSet.has(event.eventType)) return false;
    if (assetNeedle) {
      const eventAsset = (event as { asset?: string | null }).asset;
      if (!eventAsset || eventAsset.toLowerCase() !== assetNeedle) return false;
    }
    if (participantNeedle) {
      const eventParticipant = (event as { participant?: string | null })
        .participant;
      if (
        !eventParticipant ||
        eventParticipant.toLowerCase() !== participantNeedle
      ) {
        return false;
      }
    }
    if (lifecycleNeedle) {
      const eventAction = (event as { lifecycleAction?: string | null })
        .lifecycleAction;
      if (!eventAction || eventAction.toLowerCase() !== lifecycleNeedle) {
        return false;
      }
    }
    if (
      filters.fromTimestamp != null &&
      event.timestamp < filters.fromTimestamp
    ) {
      return false;
    }
    if (filters.toTimestamp != null && event.timestamp > filters.toTimestamp) {
      return false;
    }
    if (filters.search != null && !matchesSearch(event, filters.search)) {
      return false;
    }
    return true;
  });
}

function sortValue(event: BackendStreamEvent, key: ActivitySortKey): bigint {
  switch (key) {
    case "amount":
      return event.amount ? BigInt(event.amount) : 0n;
    case "streamId":
      return BigInt(event.streamId);
    case "timestamp":
    default:
      return BigInt(event.timestamp);
  }
}

/**
 * Return a new array sorted by `key`. Stable for equal keys (preserves the
 * caller's incoming order), so a resort does not reshuffle ties.
 */
export function sortActivityEvents(
  events: BackendStreamEvent[],
  key: ActivitySortKey,
  direction: SortDirection = "desc",
): BackendStreamEvent[] {
  const factor = direction === "asc" ? 1n : -1n;
  return events
    .map((event, index) => ({ event, index }))
    .sort((a, b) => {
      const delta = (sortValue(a.event, key) - sortValue(b.event, key)) * factor;
      if (delta > 0n) return 1;
      if (delta < 0n) return -1;
      return a.index - b.index;
    })
    .map(({ event }) => event);
}
