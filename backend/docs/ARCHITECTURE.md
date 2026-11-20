# Backend Architecture

This document is the canonical reference for backend service architecture. It is
referenced by `backend/src/services/indexerService.ts` and
`backend/src/services/soroban-indexer.service.ts` as the authoritative source for
indexer ownership, SSE broadcast flow, and keeper-key authorization.

For the full project-wide architecture (event type data flows, pause/resume
timing, environment variables, and operational runbook) see
[`docs/ARCHITECTURE.md`](../../docs/ARCHITECTURE.md).

---

## Architecture Decision Records

Decision records capture the data ownership, authorization, idempotency, and
on-chain/off-chain trade-offs that must be settled before introducing shared
accounts (organizations) or recurring schedules. Each record compares viable
alternatives, states the chosen option, and documents migration consequences.

### ADR-001: Organization (Shared Account) Model

**Status:** Proposed — requires review from contract and backend owners before
implementation begins.

**Context.** Users need to share streams and balances across a team. The
question is where organization membership and ownership live.

**Alternatives considered.**

| Option | Pros | Cons |
|--------|------|------|
| A. On-chain org registry (contract stores org → member mapping) | Membership is trustless and verifiable by any client; authorization enforced by the contract. | Every membership change is a transaction; higher gas and latency; contract upgrade required; wallet auth must still gate writes. |
| B. Off-chain ownership table (backend `Organization` / `OrganizationMember` Prisma models) | Cheap, fast membership edits; no contract change; reuses existing wallet auth. | Backend becomes the authorization source of truth for shared resources; on-chain state cannot enforce org permissions; requires careful audit logging. |
| C. Hybrid: off-chain membership, on-chain owner-of-record | Fast membership UX while the contract still sees a single owner address. | Two sources of truth for "who owns this stream"; reconciliation and revocation semantics are complex. |

**Decision.** Adopt **Option B (off-chain ownership table)** for the initial
release. Organization membership is stored in Prisma (`Organization`,
`OrganizationMember` with a `role` enum) and enforced by the backend API. The
contract continues to see a single owner address per stream; the backend maps
that owner to the organization. This keeps existing contract interfaces
compatible and avoids a contract upgrade.

**Data ownership.**

- **On-chain (source of truth):** stream balances, deposited/withdrawn amounts,
  and the stream owner address. These are never derived from org tables.
- **Off-chain (source of truth):** organization identity, membership, and roles.
  The backend is authoritative for org authorization only.
- **Mapping:** `Stream.ownerAddress` (on-chain) is linked to an
  `OrganizationMember.walletAddress`; an org-scoped stream is one whose owner
  address belongs to a member with the required role.

**Authorization.** Wallet-based auth is unchanged: every request must present a
signature from a wallet that is a member of the organization. Org roles
(`OWNER`, `ADMIN`, `MEMBER`) gate org-scoped actions, but the wallet signature
remains the primary credential. Chain/network validation is unchanged — the
backend still verifies the transaction targets the configured network before
acting. Org roles never bypass wallet authorization.

**Migration consequences.** Adding org tables is additive (new migrations, no
changes to existing `Stream` rows). Existing streams remain owned by their
wallet address and are treated as personal until explicitly attached to an org.
No contract migration is required. If a future ADR moves membership on-chain,
the off-chain table becomes a cache and must be reconciled against the registry.

### ADR-002: Recurring-Payment / Schedule Model

**Status:** Proposed — requires review from contract and backend owners before
implementation begins.

**Context.** Users want recurring payments (e.g. salaries) instead of one-off
streams. The question is where the schedule and its execution authority live.

**Alternatives considered.**

| Option | Pros | Cons |
|--------|------|------|
| A. On-chain scheduler (contract holds schedule and releases funds per period) | Trustless execution; no backend liveness dependency; funds custody is on-chain. | Contract complexity and upgrade cost; every period is a transaction; harder to change cadence. |
| B. Backend cron/keeper (backend triggers periodic stream creation or top-ups) | Reuses existing keeper-key flow and indexer; fast to ship; flexible cadence. | Backend liveness required; execution authority is a server key; must be idempotent to avoid double payments. |
| C. Hybrid: on-chain stream, backend-scheduled top-ups | Leverages existing stream contract; backend only schedules funding. | Still depends on backend liveness for funding; partial on-chain guarantees. |

**Decision.** Adopt **Option B (backend cron/keeper)** for the initial release,
building on the existing `KEEPER_SECRET_KEY` server-signed flow. A `Schedule`
Prisma model stores cadence, amount, and next-run time; a worker creates the
next stream/top-up when due. This reuses the existing keeper authorization and
indexer without a contract change.

**Data ownership.**

- **On-chain (source of truth):** each resulting stream's balances and the
  confirmed transactions the keeper submits.
- **Off-chain (source of truth):** the schedule definition (cadence, amount,
  next-run time) and its run history.
- **Mapping:** each `Schedule` run produces a stream/top-up transaction whose
  hash is recorded on the schedule run row; the stream itself is authoritative
  once indexed.

**Authorization.** Schedule execution is delegated to the keeper key, which is
scoped to funding operations only. The keeper cannot withdraw, change ownership,
or move funds outside the schedule's configured amount. Creating or editing a
schedule requires a wallet signature from the stream owner (or an org member
with the required role per ADR-001). Chain/network validation applies to every
keeper-submitted transaction exactly as for user-submitted ones.

**Idempotency.** Each schedule run is keyed by `(scheduleId, periodIndex)` with a
unique constraint so a retried or duplicated cron tick cannot double-pay. A run
is marked complete only after the transaction is confirmed and indexed; a
pending run is retried, not re-created.

**Migration consequences.** Adding schedule tables is additive. Existing streams
are unaffected and remain one-off. No contract migration is required. If a
future ADR moves scheduling on-chain, the backend schedule becomes a mirror and
must reconcile against on-chain state before disabling the cron.

---

## Financial Language & Risk-Disclosure Glossary

This glossary is the canonical definition of the financial terms surfaced in the
UI and API. Every user-facing label, API field description, and docs page must
use these terms with the meanings below. When a value is derived rather than
observed on-chain, the caveat column is mandatory disclosure.

| Term | Definition | Authoritative Source | Caveats / Risk Disclosure |
|------|------------|----------------------|---------------------------|
| **Streamed** | The portion of a stream's total amount that has vested by elapsed time up to the current ledger timestamp. | Contract `streamed_amount` view / `SorobanEventWorker` recomputation from `startTime`, `ratePerSecond`, and ledger time. | Time-based estimate between ledgers; not a settled balance. Do not present as withdrawable. |
| **Claimable** | The amount the recipient can withdraw right now: streamed amount minus already-withdrawn amount, clamped to the stream's remaining balance. | Contract `claimable_amount` view; mirrored by backend `withdrawnAmount` accounting. | Depends on the latest indexed ledger; may lag chain state by one poll interval. Never treat as guaranteed until a withdraw transaction confirms. |
| **Deposited** | The total amount the sender has funded into the stream (initial deposit plus any top-ups). | Contract `deposited_amount`; backend `Stream.depositedAmount` written by the indexer on `created` / `topped_up` events. | Custodial top-ups are server-signed via `KEEPER_SECRET_KEY`; a pending top-up is not yet deposited until the transaction is confirmed and indexed. |
| **Withdrawn** | The cumulative amount the recipient has successfully claimed from the stream. | Contract `withdrawn_amount`; backend `Stream.withdrawnAmount` updated on `withdrawn` events. | Additive mutation — the dual-indexer race (issue #808) can cause last-writer-wins drift until consolidation (issue #801). Treat as eventually consistent. |
| **Estimated** | Any value computed client- or server-side from time math rather than read from a confirmed on-chain state. | Frontend `useStreamEvents` projections; backend simulate endpoints (fee estimation only). | Must be labeled "estimated" in the UI. Never used for accounting, authorization, or payout decisions. |
| **Finalized** | A value backed by a confirmed, indexed on-chain transaction/event. | `StreamEvent` rows with a confirmed `transactionHash`; `Stream` fields written by `SorobanEventWorker`. | Finalized values can still be superseded by later events (e.g. a subsequent withdraw), but are never rolled back by estimation. |
| **Stale** | A displayed value whose backing indexer cursor has not advanced within the expected poll window, so it may no longer reflect chain state. | `IndexerState` cursor freshness vs. `SorobanEventWorker` poll interval; SSE heartbeat gaps. | Stale values must be visibly flagged in the UI and must not be treated as finalized. Recovery is via `replayFromLedger` (see `indexerService.ts`). |

### Consistency Rules

1. **Estimated vs. finalized.** Any value derived from time math is
   *estimated*; only values written from confirmed `StreamEvent` rows are
   *finalized*. UI must not render an estimated value with finalized styling.
2. **Stale vs. finalized.** If the `IndexerState` cursor is behind the expected
   poll window, all derived values are *stale* until the worker catches up. Stale
   is a superset of estimated: a stale finalized value is still stale.
3. **Claimable ≤ streamed − withdrawn.** This invariant must hold in every
   surface; a violation indicates indexer drift, not a UI bug.
4. **Deposited is monotonic.** Deposited only increases (deposit + top-ups); a
   decrease signals a data-integrity failure and must be surfaced, not hidden.

### Key UI & API Surfaces

These surfaces must use the glossary terms verbatim and honor the consistency
rules above:

| Surface | Terms Exposed | Notes |
|---------|---------------|-------|
| `GET /api/streams/:id` | streamed, claimable, deposited, withdrawn | Response fields map 1:1 to glossary terms; estimated fields are flagged. |
| `GET /api/streams` (list) | streamed, claimable | List projections are estimated between polls. |
| SSE `stream` events (`sse.service.ts`) | withdrawn, deposited, finalized | Event payloads are finalized once broadcast from the worker. |
| `GET /api/indexer/status` (`indexerService.ts`) | stale | Reports cursor freshness used to compute staleness. |
| Frontend `useStreamEvents` hook | estimated, stale | Client projections must be labeled estimated and flagged stale on heartbeat gaps. |

### Automated Coverage

Focused tests assert the glossary invariants and boundary transitions:

- **Stale → finalized transition:** a value flagged stale becomes finalized once
  the indexer cursor advances past the event ledger.
- **Estimated → finalized transition:** an estimated claimable value is replaced
  by the finalized on-chain value after the `withdrawn` event is indexed.
- **Boundary:** claimable clamps to zero when withdrawn equals streamed, and to
  the remaining balance when a top-up lands mid-stream.
- **Failure:** a deposited decrease is rejected/surfaced rather than silently
  applied.

---

## Indexer Ownership Model

Three files with overlapping names handle indexing and indexer management. Only
one of them is the source of truth for stream state.

| File | Role | Status |
|------|------|--------|
| `src/workers/soroban-event-worker.ts` (`SorobanEventWorker`) | **Source-of-truth indexer.** Polls Soroban RPC, decodes XDR events, persists `Stream` / `StreamEvent` rows, advances the `IndexerState` cursor, and broadcasts SSE updates. | **Active / source of truth.** Started by `src/workers/index.ts`. |
| `src/services/soroban-indexer.service.ts` (`SorobanIndexerService`) | **Legacy indexer being phased out.** A simpler duplicate poller that writes to the same DB rows and races with the worker on the same `Stream` / `StreamEvent` records (issue #801). | **Legacy — do not extend.** Removal tracked with functional consolidation (issue #801). Started directly from `src/index.ts`. |
| `src/services/indexerService.ts` | **Not an indexer at all.** Admin control-plane helpers (`getIndexerStatus`, `resetIndexer`, `replayFromLedger`) that read/reset the shared `IndexerState` cursor row and trigger the worker's poll loop. | **Active.** Name is misleading; kept alongside the legacy indexer above. |

### Key Rules

1. **When debugging indexing, read `src/workers/soroban-event-worker.ts`
   first.** It is the only file that persists canonical stream state.
2. **Do not add new behavior to `soroban-indexer.service.ts`.** It exists only
   for backwards compatibility while the double-indexer race (issue #801) is
   consolidated. Mirror any changes in `SorobanEventWorker` instead.
3. **`indexerService.ts` is control-plane only** — it never reads the chain; it
   manages the shared cursor and triggers replays.

### The Dual-Indexer Race

Both `SorobanEventWorker` and `SorobanIndexerService` poll the same Soroban RPC
for the same contract events and write to the same `Stream` and `StreamEvent`
rows. Because they run on independent timers, they can race:

- Both may process the same ledger simultaneously.
- Both write to the same `Stream` row (upsert), so the last writer wins —
  usually harmless for immutable fields but problematic for additive mutations
  like `withdrawnAmount` (issue #808).
- `StreamEvent` dedup via `@@unique([tr
