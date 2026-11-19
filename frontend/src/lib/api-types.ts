/**
 * Application type aliases derived from the auto-generated OpenAPI types.
 *
 * The generated file (`api-types.generated.ts`) is produced by running:
 *   npm run codegen:api-types  (in frontend/)
 * which calls openapi-typescript against the backend OpenAPI spec and writes
 * the result to src/lib/api-types.generated.ts.
 *
 * Rather than hand-writing types, we derive them here from
 * `components["schemas"]` in the generated file. This means any drift between
 * the backend spec and these types will be caught by the TypeScript compiler.
 *
 * For types that are not yet in the generated spec, a TODO comment is added.
 */
import type { components } from "@/lib/api-types.generated";

// ---------------------------------------------------------------------------
// User
// ---------------------------------------------------------------------------

/**
 * User as returned by the backend API (/v1/users endpoints).
 * Derived from components["schemas"]["User"].
 * The generated schema marks createdAt/updatedAt optional; we keep them
 * required here to preserve backwards-compatibility with existing call sites.
 */
export type BackendUser = Required<Pick<components["schemas"]["User"], "id" | "publicKey">> &
  Pick<components["schemas"]["User"], "createdAt" | "updatedAt">;

// ---------------------------------------------------------------------------
// Stream events
// ---------------------------------------------------------------------------

/**
 * The union of all known stream event type strings.
 *
 * The generated spec defines 8 event types. FEE_CONFIG_UPDATED and
 * ADMIN_TRANSFERRED are emitted by the contract but not yet documented in the
 * OpenAPI spec.
 * TODO: add FEE_CONFIG_UPDATED and ADMIN_TRANSFERRED to the backend OpenAPI spec,
 * then replace this hand-written union with:
 *   export type StreamEventType = components["schemas"]["StreamEvent"]["eventType"];
 */
export type StreamEventType =
  | components["schemas"]["StreamEvent"]["eventType"]
  | "FEE_CONFIG_UPDATED"
  | "ADMIN_TRANSFERRED";

/**
 * A single stream event as returned by the backend API.
 * Derived from components["schemas"]["StreamEvent"].
 *
 * Notes on differences from the generated schema:
 * - `amount` is `string | null` here (was already optional+null in spec).
 * - `createdAt` is kept required (spec marks it optional).
 * - `eventType` is widened to `StreamEventType` to include the two extra
 *   event types not yet in the spec (FEE_CONFIG_UPDATED, ADMIN_TRANSFERRED).
 */
export interface BackendStreamEvent
  extends Omit<components["schemas"]["StreamEvent"], "eventType" | "amount" | "createdAt"> {
  eventType: StreamEventType;
  amount: string | null;
  createdAt: string;
}

// ---------------------------------------------------------------------------
// Stream
// ---------------------------------------------------------------------------

/**
 * A payment stream record as returned by the backend API.
 * Derived from components["schemas"]["Stream"].
 *
 * Notes on differences from the generated schema:
 * - Several fields the spec marks optional are kept required here because
 *   the application logic relies on them always being present in responses.
 *   TODO: align the spec to mark these required, then simplify this type.
 * - `senderUser` / `recipientUser` and `events` are not yet in the spec.
 *   TODO: add them to the OpenAPI spec.
 */
export interface BackendStream
  extends Omit<
    components["schemas"]["Stream"],
    | "depositedAmount"
    | "withdrawnAmount"
    | "startTime"
    | "lastUpdateTime"
    | "isActive"
    | "isPaused"
    | "createdAt"
    | "updatedAt"
  > {
  // Fields that the spec marks optional but the app requires:
  depositedAmount: string;
  withdrawnAmount: string;
  startTime: number;
  lastUpdateTime: number;
  isActive: boolean;
  isPaused?: boolean;
  createdAt: string;
  updatedAt: string;
  // TODO: add senderUser, recipientUser, and events to the OpenAPI spec.
  senderUser?: BackendUser;
  recipientUser?: BackendUser;
  events?: BackendStreamEvent[];
}

// ---------------------------------------------------------------------------
// Stream event activity explorer (filters + pagination)
// ---------------------------------------------------------------------------

/**
 * Lifecycle action filter accepted by the stream events activity endpoint.
 *
 * Mirrors the `action` query parameter of `GET /v1/streams/events` (see
 * `paths["/v1/streams/events"]["get"]["parameters"]["query"]`).
 * TODO: replace with the derived query-param type once the backend spec
 * documents the `action` enum explicitly:
 *   export type StreamEventActionFilter =
 *     NonNullable<components["schemas"]["StreamEventListQuery"]["action"]>;
 */
export type StreamEventActionFilter =
  | "created"
  | "deposited"
  | "withdrawn"
  | "paused"
  | "resumed"
  | "cancelled"
  | "completed"
  | "fee_config_updated"
  | "admin_transferred";

/**
 * Composable filter parameters for the activity explorer.
 *
 * All fields are optional; omitted fields mean "no constraint". The values are
 * serialized into the URL query string so filter state is addressable and
 * survives browser back/forward navigation.
 *
 * TODO: derive from the OpenAPI query parameters once the spec models the
 * full filter set (asset, participant, action, date range, pagination).
 */
export interface StreamEventFilters {
  /** Filter by streamed asset code (e.g. "USDC"). */
  asset?: string;
  /** Filter by participant public key (sender or recipient). */
  participant?: string;
  /** Filter by lifecycle action. */
  action?: StreamEventActionFilter;
  /** Inclusive lower bound on event time (ISO-8601 date or datetime). */
  from?: string;
  /** Inclusive upper bound on event time (ISO-8601 date or datetime). */
  to?: string;
}

/**
 * Pagination parameters for the activity explorer.
 *
 * `limit`/`offset` are the primary, stable pagination mechanism. `cursor` is an
 * optional opaque token for keyset pagination; when present it takes
 * precedence over `offset` on the backend.
 *
 * TODO: derive from the OpenAPI query parameters once documented.
 */
export interface StreamEventPagination {
  limit?: number;
  offset?: number;
  cursor?: string;
}

/**
 * A single page of stream events as returned by the activity endpoint.
 *
 * Derived from `components["schemas"]["StreamEvent"]` for the event items so
 * the item shape stays in sync with the rest of the app (`BackendStreamEvent`).
 *
 * TODO: add a `StreamEventsPage` schema to the backend OpenAPI spec, then
 * replace this hand-written interface with:
 *   export type StreamEventsPage = components["schemas"]["StreamEventsPage"];
 */
export interface StreamEventsPage {
  /** Events for the current page, newest first. */
  events: BackendStreamEvent[];
  /** Total number of events matching the filters (ignoring pagination). */
  total: number;
  /** Maximum number of events requested for this page. */
  limit: number;
  /** Number of events skipped before this page. */
  offset: number;
  /** True when more events exist beyond this page. */
  hasMore: boolean;
  /** Opaque cursor for fetching the next page, when cursor pagination is used. */
  nextCursor?: string | null;
}

// ---------------------------------------------------------------------------
// Operation-specific response types (derived from `paths`)
// ---------------------------------------------------------------------------

// Re-export generated component schemas for consumers that want direct access.
export type { components } from "@/lib/api-types.generated";
