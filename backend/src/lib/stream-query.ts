import { parseStreamId } from './stream-id.js';
import {
  getConfiguredStellarNetwork,
  type StellarNetworkId,
} from './stellar-network.js';

/**
 * Normalized stream search and filter semantics (issue #230).
 *
 * Enforces canonical normalization, strict boundary validation, and explicit
 * conflict/range errors at the API boundary so clients and operators observe
 * deterministic filter evaluation instead of silent fallbacks.
 */

export const STREAM_STATUS_VALUES = [
  'active',
  'paused',
  'cancelled',
  'completed',
] as const;

export type StreamFilterStatus = (typeof STREAM_STATUS_VALUES)[number];

export const STREAM_SORT_FIELDS = [
  'createdAt',
  'startTime',
  'lastUpdateTime',
  'depositedAmount',
  'endTime',
  'streamId',
] as const;

export type StreamSortField = (typeof STREAM_SORT_FIELDS)[number];
export type StreamSortOrder = 'asc' | 'desc';

export const DEFAULT_STREAM_PAGE_SIZE = 20;
export const MAX_STREAM_PAGE_SIZE = 100;
export const MAX_SEARCH_QUERY_LENGTH = 128;

const STELLAR_STRKEY_PATTERN = /^[GC][A-Z2-7]{55}$/i;

const SORT_FIELD_ALIASES: Record<string, StreamSortField> = {
  createdat: 'createdAt',
  created_at: 'createdAt',
  starttime: 'startTime',
  start_time: 'startTime',
  lastupdatetime: 'lastUpdateTime',
  last_update_time: 'lastUpdateTime',
  depositedamount: 'depositedAmount',
  deposited_amount: 'depositedAmount',
  endtime: 'endTime',
  end_time: 'endTime',
  streamid: 'streamId',
  stream_id: 'streamId',
};

const VALID_STATUS_SET = new Set<string>(STREAM_STATUS_VALUES);

export interface StreamQueryErrorDetails {
  field?: string | undefined;
  allowedValues?: readonly string[] | undefined;
  recoveryHint: string;
  [key: string]: unknown;
}

export class StreamQueryValidationError extends Error {
  public readonly status: number;
  public readonly code: string;
  public readonly details: StreamQueryErrorDetails;

  constructor(
    status: number,
    code: string,
    message: string,
    details: StreamQueryErrorDetails,
  ) {
    super(message);
    this.name = 'StreamQueryValidationError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export interface NormalizedStreamSearchParams {
  network: StellarNetworkId;
  sender?: string | undefined;
  recipient?: string | undefined;
  participant?: string | undefined;
  tokenAddress?: string | undefined;
  statuses?: StreamFilterStatus[] | undefined;
  search?: string | undefined;
  searchStreamId?: bigint | undefined;
  startTimeFrom?: bigint | undefined;
  startTimeTo?: bigint | undefined;
  endTimeFrom?: bigint | undefined;
  endTimeTo?: bigint | undefined;
  createdAfter?: Date | undefined;
  createdBefore?: Date | undefined;
  sortField: StreamSortField;
  sortOrder: StreamSortOrder;
  limit: number;
  offset: number;
  cursor?: string | undefined;
}

export interface AppliedStreamFilters {
  network: StellarNetworkId;
  sender: string | null;
  recipient: string | null;
  participant: string | null;
  tokenAddress: string | null;
  statuses: StreamFilterStatus[];
  search: string | null;
  startTimeFrom: string | null;
  startTimeTo: string | null;
  endTimeFrom: string | null;
  endTimeTo: string | null;
  createdAfter: string | null;
  createdBefore: string | null;
  sort: StreamSortField;
  order: StreamSortOrder;
  paginationMode: 'cursor' | 'offset';
  limit: number;
  offset: number;
  cursor: string | null;
}

export interface NormalizedStreamSearchResult {
  params: NormalizedStreamSearchParams;
  appliedFilters: AppliedStreamFilters;
}

function readSingleString(raw: unknown, field: string): string | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (Array.isArray(raw)) {
    const first = raw[0];
    if (raw.length > 1) {
      throw new StreamQueryValidationError(
        400,
        'DUPLICATE_QUERY_PARAMETER',
        `Query parameter "${field}" must only be supplied once`,
        {
          field,
          recoveryHint: `Supply a single value for "${field}".`,
        },
      );
    }
    return typeof first === 'string' ? first : String(first);
  }
  if (typeof raw === 'string') return raw;
  if (typeof raw === 'number' || typeof raw === 'boolean') return String(raw);
  throw new StreamQueryValidationError(
    400,
    'INVALID_QUERY_PARAMETER',
    `Query parameter "${field}" must be a scalar string`,
    {
      field,
      recoveryHint: `Provide a valid string value for "${field}".`,
    },
  );
}

/**
 * Normalize Stellar public keys (`G...`) and Soroban contract IDs (`C...`)
 * to canonical uppercase while preserving non-StrKey identifiers (e.g. test
 * fixtures or custom symbols) trimmed of surrounding whitespace.
 */
export function normalizeStellarIdentifier(raw: string): string {
  const trimmed = raw.trim();
  if (STELLAR_STRKEY_PATTERN.test(trimmed)) {
    return trimmed.toUpperCase();
  }
  return trimmed;
}

/**
 * Normalize free-text search queries: trim edges, collapse repeated whitespace
 * to single spaces, canonicalize Stellar StrKey addresses to uppercase, and
 * enforce bounded length.
 */
export function normalizeSearchQuery(raw: string): string {
  const collapsed = raw.trim().replace(/\s+/g, ' ');
  if (collapsed.length > MAX_SEARCH_QUERY_LENGTH) {
    throw new StreamQueryValidationError(
      400,
      'INVALID_SEARCH_QUERY',
      `Search query must be at most ${MAX_SEARCH_QUERY_LENGTH} characters`,
      {
        field: 'q',
        maxLength: MAX_SEARCH_QUERY_LENGTH,
        actualLength: collapsed.length,
        recoveryHint: `Shorten the search query to ${MAX_SEARCH_QUERY_LENGTH} characters or fewer.`,
      },
    );
  }
  if (STELLAR_STRKEY_PATTERN.test(collapsed)) {
    return collapsed.toUpperCase();
  }
  return collapsed;
}

function parseOptionalIdentifier(
  raw: unknown,
  field: string,
): string | undefined {
  const str = readSingleString(raw, field);
  if (str === undefined) return undefined;
  const normalized = normalizeStellarIdentifier(str);
  if (normalized.length === 0) {
    throw new StreamQueryValidationError(
      400,
      'INVALID_FILTER_VALUE',
      `Query parameter "${field}" must not be empty`,
      {
        field,
        recoveryHint: `Omit "${field}" or provide a non-empty identifier.`,
      },
    );
  }
  return normalized;
}

function parseStatuses(raw: unknown): StreamFilterStatus[] | undefined {
  if (raw === undefined || raw === null) return undefined;

  const rawItems = Array.isArray(raw) ? raw : [raw];
  const tokens: string[] = [];

  for (const item of rawItems) {
    const str = typeof item === 'string' ? item : String(item);
    for (const part of str.split(',')) {
      const normalized = part.trim().toLowerCase();
      if (normalized.length > 0) {
        tokens.push(normalized);
      }
    }
  }

  if (tokens.length === 0) {
    throw new StreamQueryValidationError(
      400,
      'INVALID_STATUS',
      `status must be one of: ${STREAM_STATUS_VALUES.join(', ')}`,
      {
        field: 'status',
        allowedValues: STREAM_STATUS_VALUES,
        recoveryHint: `Provide one or more comma-separated values from: ${STREAM_STATUS_VALUES.join(', ')}.`,
      },
    );
  }

  const invalid = tokens.filter((t) => !VALID_STATUS_SET.has(t));
  if (invalid.length > 0) {
    throw new StreamQueryValidationError(
      400,
      'INVALID_STATUS',
      `Invalid status value(s): ${invalid.join(', ')}. Must be one of: ${STREAM_STATUS_VALUES.join(', ')}`,
      {
        field: 'status',
        invalidValues: invalid,
        allowedValues: STREAM_STATUS_VALUES,
        recoveryHint: `Use only supported statuses: ${STREAM_STATUS_VALUES.join(', ')}.`,
      },
    );
  }

  const unique = Array.from(new Set(tokens)) as StreamFilterStatus[];
  unique.sort(
    (a, b) =>
      STREAM_STATUS_VALUES.indexOf(a) - STREAM_STATUS_VALUES.indexOf(b),
  );
  return unique;
}

function parseUnixTimestampBigInt(
  raw: unknown,
  field: string,
): bigint | undefined {
  const str = readSingleString(raw, field);
  if (str === undefined || str.trim() === '') return undefined;
  const trimmed = str.trim();
  if (!/^\d+$/.test(trimmed)) {
    throw new StreamQueryValidationError(
      400,
      'INVALID_TIMESTAMP',
      `Query parameter "${field}" must be a non-negative Unix timestamp in seconds`,
      {
        field,
        recoveryHint: `Pass "${field}" as a non-negative integer Unix timestamp (seconds).`,
      },
    );
  }
  return BigInt(trimmed);
}

function parseIsoOrUnixDate(raw: unknown, field: string): Date | undefined {
  const str = readSingleString(raw, field);
  if (str === undefined || str.trim() === '') return undefined;
  const trimmed = str.trim();

  if (/^\d+$/.test(trimmed)) {
    const seconds = Number(trimmed);
    if (!Number.isSafeInteger(seconds)) {
      throw new StreamQueryValidationError(
        400,
        'INVALID_DATE',
        `Query parameter "${field}" is out of valid date range`,
        {
          field,
          recoveryHint: `Provide "${field}" as an ISO-8601 timestamp or Unix seconds.`,
        },
      );
    }
    return new Date(seconds * 1000);
  }

  const parsed = new Date(trimmed);
  if (Number.isNaN(parsed.getTime())) {
    throw new StreamQueryValidationError(
      400,
      'INVALID_DATE',
      `Query parameter "${field}" must be a valid ISO-8601 date or Unix timestamp`,
      {
        field,
        recoveryHint: `Provide "${field}" as an ISO-8601 date (e.g. 2026-01-01T00:00:00Z).`,
      },
    );
  }
  return parsed;
}

function parseStrictPositiveInt(
  raw: unknown,
  field: string,
  min: number,
  max?: number,
): number | undefined {
  const str = readSingleString(raw, field);
  if (str === undefined || str.trim() === '') return undefined;
  const trimmed = str.trim();
  if (!/^-?\d+$/.test(trimmed)) {
    throw new StreamQueryValidationError(
      400,
      'INVALID_PAGINATION',
      `Query parameter "${field}" must be an integer`,
      {
        field,
        recoveryHint: `Pass "${field}" as an integer${max !== undefined ? ` between ${min} and ${max}` : ` >= ${min}`}.`,
      },
    );
  }
  const value = Number.parseInt(trimmed, 10);
  if (
    !Number.isSafeInteger(value) ||
    value < min ||
    (max !== undefined && value > max)
  ) {
    throw new StreamQueryValidationError(
      400,
      'INVALID_PAGINATION',
      max !== undefined
        ? `Query parameter "${field}" must be an integer between ${min} and ${max}`
        : `Query parameter "${field}" must be an integer >= ${min}`,
      {
        field,
        min,
        ...(max !== undefined ? { max } : {}),
        recoveryHint:
          max !== undefined
            ? `Use a "${field}" between ${min} and ${max}.`
            : `Use a "${field}" >= ${min}.`,
      },
    );
  }
  return value;
}

function resolveAliasConflict(
  primaryValue: string | undefined,
  primaryName: string,
  aliasValue: string | undefined,
  aliasName: string,
): string | undefined {
  if (
    primaryValue !== undefined &&
    aliasValue !== undefined &&
    primaryValue !== aliasValue
  ) {
    throw new StreamQueryValidationError(
      400,
      'CONFLICTING_FILTERS',
      `Conflicting query parameters: "${primaryName}" and "${aliasName}" specify different values`,
      {
        field: primaryName,
        conflictingField: aliasName,
        recoveryHint: `Supply only one of "${primaryName}" or "${aliasName}", or ensure both match.`,
      },
    );
  }
  return primaryValue ?? aliasValue;
}

/**
 * Parse, normalize, and validate query parameters for `GET /v1/streams`.
 */
export function normalizeStreamSearchQuery(
  rawQuery: Record<string, unknown>,
): NormalizedStreamSearchResult {
  const configuredNetwork = getConfiguredStellarNetwork();
  const rawNetwork = readSingleString(rawQuery['network'], 'network');
  if (rawNetwork !== undefined) {
    const normalizedNetwork = rawNetwork.trim().toLowerCase();
    if (normalizedNetwork !== configuredNetwork) {
      throw new StreamQueryValidationError(
        409,
        'NETWORK_MISMATCH',
        `This indexer serves ${configuredNetwork}, not ${rawNetwork}.`,
        {
          field: 'network',
          configuredNetwork,
          requestedNetwork: rawNetwork,
          recoveryHint: `Target the ${configuredNetwork} endpoint or omit the network parameter.`,
        },
      );
    }
  }

  const sender = parseOptionalIdentifier(rawQuery['sender'], 'sender');
  const recipient = parseOptionalIdentifier(rawQuery['recipient'], 'recipient');

  const participantPrimary = parseOptionalIdentifier(
    rawQuery['participant'],
    'participant',
  );
  const participantAlias = parseOptionalIdentifier(
    rawQuery['address'],
    'address',
  );
  const participant = resolveAliasConflict(
    participantPrimary,
    'participant',
    participantAlias,
    'address',
  );

  const tokenPrimary = parseOptionalIdentifier(rawQuery['token'], 'token');
  const tokenAlias = parseOptionalIdentifier(
    rawQuery['tokenAddress'],
    'tokenAddress',
  );
  const tokenAddress = resolveAliasConflict(
    tokenPrimary,
    'token',
    tokenAlias,
    'tokenAddress',
  );

  const statuses = parseStatuses(rawQuery['status']);

  const qRaw = readSingleString(rawQuery['q'], 'q');
  const searchRaw = readSingleString(rawQuery['search'], 'search');
  const normalizedQ =
    qRaw !== undefined && qRaw.trim() !== ''
      ? normalizeSearchQuery(qRaw)
      : undefined;
  const normalizedSearchAlias =
    searchRaw !== undefined && searchRaw.trim() !== ''
      ? normalizeSearchQuery(searchRaw)
      : undefined;
  const search = resolveAliasConflict(
    normalizedQ,
    'q',
    normalizedSearchAlias,
    'search',
  );
  const searchStreamId =
    search !== undefined ? (parseStreamId(search) ?? undefined) : undefined;

  const startTimeFrom =
    parseUnixTimestampBigInt(rawQuery['startTimeFrom'], 'startTimeFrom') ??
    parseUnixTimestampBigInt(rawQuery['startAfter'], 'startAfter');
  const startTimeTo =
    parseUnixTimestampBigInt(rawQuery['startTimeTo'], 'startTimeTo') ??
    parseUnixTimestampBigInt(rawQuery['startBefore'], 'startBefore');
  if (
    startTimeFrom !== undefined &&
    startTimeTo !== undefined &&
    startTimeFrom > startTimeTo
  ) {
    throw new StreamQueryValidationError(
      400,
      'INVALID_RANGE',
      'startTimeFrom must be less than or equal to startTimeTo',
      {
        field: 'startTimeFrom',
        recoveryHint:
          'Ensure startTimeFrom (startAfter) <= startTimeTo (startBefore).',
      },
    );
  }

  const endTimeFrom = parseUnixTimestampBigInt(
    rawQuery['endTimeFrom'],
    'endTimeFrom',
  );
  const endTimeTo = parseUnixTimestampBigInt(
    rawQuery['endTimeTo'],
    'endTimeTo',
  );
  if (
    endTimeFrom !== undefined &&
    endTimeTo !== undefined &&
    endTimeFrom > endTimeTo
  ) {
    throw new StreamQueryValidationError(
      400,
      'INVALID_RANGE',
      'endTimeFrom must be less than or equal to endTimeTo',
      {
        field: 'endTimeFrom',
        recoveryHint: 'Ensure endTimeFrom <= endTimeTo.',
      },
    );
  }

  const createdAfter = parseIsoOrUnixDate(
    rawQuery['createdAfter'],
    'createdAfter',
  );
  const createdBefore = parseIsoOrUnixDate(
    rawQuery['createdBefore'],
    'createdBefore',
  );
  if (
    createdAfter !== undefined &&
    createdBefore !== undefined &&
    createdAfter.getTime() > createdBefore.getTime()
  ) {
    throw new StreamQueryValidationError(
      400,
      'INVALID_RANGE',
      'createdAfter must be less than or equal to createdBefore',
      {
        field: 'createdAfter',
        recoveryHint: 'Ensure createdAfter <= createdBefore.',
      },
    );
  }

  const rawSort =
    readSingleString(rawQuery['sort'], 'sort') ??
    readSingleString(rawQuery['sortBy'], 'sortBy');
  let sortField: StreamSortField = 'createdAt';
  if (rawSort !== undefined && rawSort.trim() !== '') {
    const mapped = SORT_FIELD_ALIASES[rawSort.trim().toLowerCase()];
    if (!mapped) {
      throw new StreamQueryValidationError(
        400,
        'INVALID_SORT_FIELD',
        `Unsupported sort field "${rawSort}". Allowed values: ${STREAM_SORT_FIELDS.join(', ')}`,
        {
          field: 'sort',
          allowedValues: STREAM_SORT_FIELDS,
          recoveryHint: `Use one of the supported sort fields: ${STREAM_SORT_FIELDS.join(', ')}.`,
        },
      );
    }
    sortField = mapped;
  }

  const rawOrder =
    readSingleString(rawQuery['order'], 'order') ??
    readSingleString(rawQuery['sortOrder'], 'sortOrder');
  let sortOrder: StreamSortOrder = 'desc';
  if (rawOrder !== undefined && rawOrder.trim() !== '') {
    const lowered = rawOrder.trim().toLowerCase();
    if (lowered !== 'asc' && lowered !== 'desc') {
      throw new StreamQueryValidationError(
        400,
        'INVALID_SORT_ORDER',
        `order must be "asc" or "desc", received "${rawOrder}"`,
        {
          field: 'order',
          allowedValues: ['asc', 'desc'],
          recoveryHint: 'Use order=asc or order=desc.',
        },
      );
    }
    sortOrder = lowered;
  }

  const parsedLimit =
    parseStrictPositiveInt(rawQuery['limit'], 'limit', 1, MAX_STREAM_PAGE_SIZE) ??
    parseStrictPositiveInt(
      rawQuery['pageSize'],
      'pageSize',
      1,
      MAX_STREAM_PAGE_SIZE,
    ) ??
    DEFAULT_STREAM_PAGE_SIZE;

  const explicitOffset = parseStrictPositiveInt(rawQuery['offset'], 'offset', 0);
  const explicitPage = parseStrictPositiveInt(rawQuery['page'], 'page', 1);

  if (
    explicitOffset !== undefined &&
    explicitPage !== undefined &&
    explicitOffset !== (explicitPage - 1) * parsedLimit
  ) {
    throw new StreamQueryValidationError(
      400,
      'CONFLICTING_PAGINATION',
      'Conflicting pagination parameters: "offset" and "page" disagree',
      {
        field: 'offset',
        recoveryHint: 'Specify either "offset" or "page", not conflicting values.',
      },
    );
  }

  const offset =
    explicitOffset ??
    (explicitPage !== undefined ? (explicitPage - 1) * parsedLimit : 0);

  const rawCursor = readSingleString(rawQuery['cursor'], 'cursor');
  let cursor: string | undefined;
  if (rawCursor !== undefined && rawCursor.trim() !== '') {
    const trimmedCursor = rawCursor.trim();
    if (!/^\d+$/.test(trimmedCursor)) {
      throw new StreamQueryValidationError(
        400,
        'INVALID_CURSOR',
        'cursor must be a numeric stream ID',
        {
          field: 'cursor',
          recoveryHint:
            'Pass the exact `nextCursor` value returned by the previous page.',
        },
      );
    }
    if (offset > 0) {
      throw new StreamQueryValidationError(
        400,
        'CONFLICTING_PAGINATION',
        'Cannot combine "cursor" with a non-zero "offset" or "page" > 1',
        {
          field: 'cursor',
          recoveryHint:
            'Use either cursor-based pagination (`cursor`) or offset-based pagination (`offset`/`page`), not both.',
        },
      );
    }
    cursor = trimmedCursor;
  }

  const params: NormalizedStreamSearchParams = {
    network: configuredNetwork,
    sortField,
    sortOrder,
    limit: parsedLimit,
    offset,
    ...(sender !== undefined ? { sender } : {}),
    ...(recipient !== undefined ? { recipient } : {}),
    ...(participant !== undefined ? { participant } : {}),
    ...(tokenAddress !== undefined ? { tokenAddress } : {}),
    ...(statuses !== undefined ? { statuses } : {}),
    ...(search !== undefined ? { search } : {}),
    ...(searchStreamId !== undefined ? { searchStreamId } : {}),
    ...(startTimeFrom !== undefined ? { startTimeFrom } : {}),
    ...(startTimeTo !== undefined ? { startTimeTo } : {}),
    ...(endTimeFrom !== undefined ? { endTimeFrom } : {}),
    ...(endTimeTo !== undefined ? { endTimeTo } : {}),
    ...(createdAfter !== undefined ? { createdAfter } : {}),
    ...(createdBefore !== undefined ? { createdBefore } : {}),
    ...(cursor !== undefined ? { cursor } : {}),
  };

  const appliedFilters: AppliedStreamFilters = {
    network: configuredNetwork,
    sender: sender ?? null,
    recipient: recipient ?? null,
    participant: participant ?? null,
    tokenAddress: tokenAddress ?? null,
    statuses: statuses ?? [],
    search: search ?? null,
    startTimeFrom: startTimeFrom !== undefined ? startTimeFrom.toString() : null,
    startTimeTo: startTimeTo !== undefined ? startTimeTo.toString() : null,
    endTimeFrom: endTimeFrom !== undefined ? endTimeFrom.toString() : null,
    endTimeTo: endTimeTo !== undefined ? endTimeTo.toString() : null,
    createdAfter: createdAfter ? createdAfter.toISOString() : null,
    createdBefore: createdBefore ? createdBefore.toISOString() : null,
    sort: sortField,
    order: sortOrder,
    paginationMode: cursor ? 'cursor' : 'offset',
    limit: parsedLimit,
    offset,
    cursor: cursor ?? null,
  };

  return { params, appliedFilters };
}
