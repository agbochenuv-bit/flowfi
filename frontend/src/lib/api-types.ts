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
// Organization workspace
// ---------------------------------------------------------------------------

/**
 * Roles a user can hold within an organization workspace.
 *
 * - `owner`: full control, including wallet signing ownership and billing.
 * - `admin`: can manage members and invitations, but cannot transfer ownership.
 * - `member`: read access to workspace data; cannot manage members.
 * - `viewer`: read-only access to streams and reports.
 */
export type OrganizationRole = "owner" | "admin" | "member" | "viewer";

/**
 * Lifecycle states of an organization invitation.
 *
 * - `pending`: sent, awaiting acceptance.
 * - `accepted`: accepted by the invitee; a membership now exists.
 * - `declined`: explicitly declined by the invitee.
 * - `revoked`: cancelled by an admin/owner before acceptance.
 * - `expired`: passed its expiry without being accepted.
 */
export type OrganizationInvitationStatus =
  | "pending"
  | "accepted"
  | "declined"
  | "revoked"
  | "expired";

/**
 * A member of an organization workspace.
 *
 * `walletAddress` is the member's own wallet. Signing authority always stays
 * with the wallet owner; membership never grants the ability to sign on
 * another wallet's behalf.
 */
export interface OrganizationMember {
  id: string;
  organizationId: string;
  userId: string;
  walletAddress: string;
  role: OrganizationRole;
  /** Whether this member is the wallet-signing owner of the workspace. */
  isSigningOwner: boolean;
  joinedAt: string;
  createdAt: string;
  updatedAt: string;
}

/**
 * An invitation to join an organization workspace.
 *
 * `invitedByUserId` identifies the member who issued the invitation.
 * `expiresAt` is an ISO timestamp; invitations past it are `expired`.
 */
export interface OrganizationInvitation {
  id: string;
  organizationId: string;
  email: string;
  role: OrganizationRole;
  status: OrganizationInvitationStatus;
  invitedByUserId: string;
  /** Wallet address the invitation is addressed to, if known at invite time. */
  walletAddress?: string;
  expiresAt: string;
  createdAt: string;
  updatedAt: string;
}

/**
 * An organization workspace as returned by the backend API.
 *
 * `signingOwnerWallet` is the wallet that owns signing authority for the
 * workspace. Only that wallet may sign transactions on the workspace's behalf.
 */
export interface Organization {
  id: string;
  name: string;
  slug: string;
  /** Wallet address holding signing authority for this workspace. */
  signingOwnerWallet: string;
  /** Role of the requesting user within this organization. */
  currentUserRole: OrganizationRole;
  members?: OrganizationMember[];
  createdAt: string;
  updatedAt: string;
}

// ---------------------------------------------------------------------------
// Operation-specific response types (derived from `paths`)
// ---------------------------------------------------------------------------

// Re-export generated component schemas for consumers that want direct access.
export type { components } from "@/lib/api-types.generated";
