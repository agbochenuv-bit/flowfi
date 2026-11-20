# Backend Architecture

This document is the canonical reference for backend service architecture. It is
referenced by `backend/src/services/indexerService.ts` and
`backend/src/services/soroban-indexer.service.ts` as the authoritative source for
indexer ownership, SSE broadcast flow, and keeper-key authorization.

For the full project-wide architecture (event type data flows, pause/resume
timing, environment variables, and operational runbook) see
[`docs/ARCHITECTURE.md`](../../docs/ARCHITECTURE.md).

For the field-level privacy and retention inventory (wallet-linked fields across
logs, analytics, exports, webhooks, and backups) see
[Field-Level Privacy & Retention Inventory](#field-level-privacy--retention-inventory)
below.

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
- `StreamEvent` dedup via `@@unique([transactionHash, eventType])` prevents
  duplicate event rows, but does **not** protect stream state mutations.

**Mitigation:** Do not extend the legacy indexer. The consolidation (issue #801)
will remove `SorobanIndexerService` entirely.

### Naming Convention Plan

The team convention is kebab-case with a `.service.ts` suffix. Once functional
consolidation lands:

| Current Name | Expected Future Name |
|---|---|
| `indexerService.ts` | `indexer.service.ts` |
| `soroban-indexer.service.ts` | *(removed)* |

---

## SSE Broadcast Flow

The SSE (Server-Sent Events) subsystem delivers real-time contract event
notifications to connected frontend clients. The full SSE architecture (scaling,
memory, security) is documented in
[`docs/SSE_ARCHITECTURE.md`](./SSE_ARCHITECTURE.md).

### End-to-End Path

```
Soroban RPC
    │  SorobanEventWorker polls for new contract events
    ▼
SorobanEventWorker (src/workers/soroban-event-worker.ts)
    │  decode XDR → upsert Stream → insert StreamEvent
    ▼
PostgreSQL (via Prisma)
    │  Stream + StreamEvent rows updated
    ▼
SSE broadcast (src/services/sse.service.ts)
    │  sseService.broadcastToStream(streamId, event, data)
    │  sseService.broadcastToUser(publicKey, event, data)
    │  sseService.broadcastToAdmin(event, data)
    │
    ├──► [Single instance]  Direct write to in-memory client registry
    │
    └──► [Multi-instance]   Redis Pub/Sub
                             │  publish to sse:stream:<id>, sse:user:<address>
                             ▼
                             All backend instances subscribe
                             │  rebroadcast to local connected clients
                             ▼
                         Frontend (useStreamEvents hook)
```

### Broadcast Channels

The worker uses three broadcast entry points depending on the event:

| Method | When Used | Target Audience |
|--------|-----------|-----------------|
| `sseService.broadcastToStream(streamId, event, data)` | Stream lifecycle events (created, topped_up, withdrawn, cancelled, completed, paused, resumed) | Clients subscribed to that specific stream ID or `*` |
| `sseService.broadcastToUser(publicKey, event, data)` | (Reserved for user-scoped events) | Clients subscribed to `user:<publicKey>` or `*` |
| `sseService.broadcastToAdmin(event, data)` | Protocol-level events (fee_collected, fee_config_updated, admin_transferred) | The admin user identified by `ADMIN_PUBLIC_KEY` env var |

### Multi-Instance Fanout

When `REDIS_URL` is configured, broadcasts go through Redis Pub/Sub instead of
direct in-memory writes:

1. The originating instance publishes `{ event, data }` to
   `sse:stream:<id>` or `sse:user:<address>`.
2. Every backend instance subscribes via `psubscribe('sse:stream:*',
   'sse:user:*')` and rebroadcasts to its own local clients.
3. This means events reach all connected clients regardless of which backend
   instance they are connected to.

### Client Connection Limits

| Limit | Default | Env Var |
|-------|---------|---------|
| Max SSE connections per server | 10,000 | `MAX_SSE_CONNECTIONS` |
| Max connections per IP | 5 | Hardcoded |
| Max connections per authenticated user | 10 | Hardcoded |

Slow clients (write buffer ≥ 64 KB) are automatically dropped to protect
throughput for healthy clients.

---

## Keeper-Key Authorization Model

FlowFi splits transaction signing into two categories: custodial (server-signed)
and non-custodial (wallet-signed). The signing key determines who is responsible
for the transaction.

### Action Signing Matrix

| Action | Signer | Mechanism |
|--------|--------|-----------|
| **Top-up** | Server (custodial) | Backend submits the transaction using `KEEPER_SECRET_KEY`. The frontend sends only the stream ID and amount. |
| **Withdraw** | Wallet (non-custodial) | Frontend builds and signs the transaction via the connected wallet (Freighter). The backend simulate endpoint exists for fee estimation only. |
| **Pause / Resume** | Wallet (non-custodial) | Same as withdraw — frontend-signed. Backend simulate endpoints exist for fee estimation but do not submit. |
| **Create stream** | Wallet (non-custodial) | Frontend signs via wallet and submits directly to the Soroban RPC. |

### The `KEEPER_SECRET_KEY`

- Stored as an environment variable on the backend.
- Loaded by `src/services/sorobanService.ts` via
  `process.env.KEEPER_SECRET_KEY`.
- Used **exclusively** by the top-up flow. The `topUpStream` function builds
  the transaction, signs it with the keeper keypair, and submits it to the
  Soroban RPC.
- If `KEEPER_SECRET_KEY` is not configured, `topUpStream` throws
  `'KEEPER_SECRET_KEY not configured'` and the request returns HTTP 500.
- The cancel endpoint (`src/controllers/stream/cancel.ts`) also reads
  `KEEPER_SECRET_KEY` but only to check whether the server wallet is configured;
  the actual cancel transaction is wallet-signed by the sender.

### Security Boundary

> **Do not wire pause/resume/withdraw to a server-side submit path.** Only
> `top-up` is intentionally custodial. All other mutating actions must be
> wallet-signed by the user to preserve the non-custodial security model.

The keeper key is a server-side secret and is never exposed to the frontend.

---

## Field-Level Privacy & Retention Inventory

This inventory maps every wallet-linked field family to its data store, purpose,
retention rule, deletion constraint, and accountable owner. It is the review
baseline for product and operations changes: any change that adds, moves, or
re-purposes a wallet-linked field must update this table in the same PR.

**Wallet-linked field families** (the identifiers this inventory governs):

- `publicKey` / `sender` / `recipient` — Stellar account addresses (G…).
- `transactionHash` — on-chain transaction identifier.
- `streamId` — internal stream identifier that resolves to the above.
- `keeperPublicKey` — server wallet address (never the secret).

### Inventory

| Field family | Data store | Purpose | Retention rule | Deletion constraint | Owner | Policy |
|---|---|---|---|---|---|---|
| `publicKey`, `sender`, `recipient` | PostgreSQL (`Stream`, `StreamEvent`, `User`) | Stream lifecycle, authorization, and user-facing history | Retained for the life of the stream plus the accounting retention window; no TTL purge | Cannot be deleted while the stream is active or referenced by financial accounting rows; anonymize only after archival | Backend / Data | [`SECURITY.md`](../../SECURITY.md), [`docs/ARCHITECTURE.md`](../../docs/ARCHITECTURE.md) |
| `transactionHash`, `streamId` | PostgreSQL (`StreamEvent`) | Event dedup, replay, and audit trail | Retained with the parent stream; immutable once written | Immutable — never deleted independently of the parent stream | Backend / Indexer | [`docs/ARCHITECTURE.md`](../../docs/ARCHITECTURE.md) (Indexer Ownership Model) |
| `publicKey` (request context) | Application logs | Debugging, incident response, abuse detection | Short-lived; rotated with log retention window | Purged with log rotation; must never be logged alongside secrets | Operations | [`SECURITY.md`](../../SECURITY.md) |
| `publicKey`, `streamId` | Analytics events | Product usage metrics and funnel analysis | Aggregated/pseudonymized; raw identifiers dropped at aggregation | Raw identifiers must not be joined back to financial records; deletion via aggregation refresh | Product / Data | [`SECURITY.md`](../../SECURITY.md) |
| `publicKey`, `sender`, `recipient`, `transactionHash` | User-initiated exports (CSV/JSON) | User data portability and reporting | Generated on demand; not persisted server-side beyond the request | User-scoped only — exports must be filtered by the requesting wallet; no cross-wallet leakage | Backend / API | [`backend/docs/AUTHENTICATION.md`](./AUTHENTICATION.md) |
| `publicKey`, `streamId`, `transactionHash` | Outbound webhooks | Partner integrations and event delivery | Delivered payloads retained only in delivery retry buffer | Payloads must be scoped to the subscribed wallet; no bulk wallet enumeration | Integrations | [`SECURITY.md`](../../SECURITY.md) |
| `publicKey`, `sender`, `recipient`, `transactionHash`, `streamId` | Database backups | Disaster recovery | Retained per backup rotation schedule | Cannot be selectively deleted from a backup; deletion is satisfied by expiry of the backup generation | Operations | [`SECURITY.md`](../../SECURITY.md), [`.github/SECURITY_SETUP_CHECKLIST.md`](../../.github/SECURITY_SETUP_CHECKLIST.md) |
| `keeperPublicKey` | PostgreSQL (`Stream`), logs | Attributing custodial top-ups | Retained with the stream; public key only | Never store or log `KEEPER_SECRET_KEY`; only the public key is inventory-scoped | Backend / Security | [`SECURITY.md`](../../SECURITY.md) |

### Review Rules

1. **Every wallet-linked field family must have an owner and a linked policy.**
   A row missing either is incomplete and blocks merge.
2. **Every row must state a retention rule and a deletion constraint.** "No
   retention" is not a valid entry — use an explicit window or "life of stream".
3. **New stores require a new row.** Adding a log sink, analytics pipeline,
   export format, webhook target, or backup destination that carries a
   wallet-linked field requires updating this table in the same change.
4. **Deletion constraints win over convenience.** If a field cannot be deleted
   (e.g. immutable event rows, backup generations), document the constraint
   rather than silently dropping the field.
5. **Secrets are out of scope for this inventory.** Only public wallet
   identifiers are mapped; `KEEPER_SECRET_KEY` and other secrets follow
   [`SECURITY.md`](../../SECURITY.md) and are never logged or exported.

### Change Checklist

When a change touches a wallet-linked field, confirm:

- [ ] The field family is listed in the inventory (or a new row was added).
- [ ] The data store, purpose, retention rule, and deletion constraint are accurate.
- [ ] An owner and a linked policy are present.
- [ ] Exports and webhooks remain scoped to the requesting/subscribed wallet.
- [ ] No secret material was introduced into logs, analytics, exports, or webhooks.
