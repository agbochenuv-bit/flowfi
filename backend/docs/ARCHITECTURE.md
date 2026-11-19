# Backend Architecture

This document is the canonical reference for backend service architecture. It is
referenced by `backend/src/services/indexerService.ts` and
`backend/src/services/soroban-indexer.service.ts` as the authoritative source for
indexer ownership, SSE broadcast flow, and keeper-key authorization.

For the full project-wide architecture (event type data flows, pause/resume
timing, environment variables, and operational runbook) see
[`docs/ARCHITECTURE.md`](../../docs/ARCHITECTURE.md).

**Document version:** 1.0.0 — see [Versioning & Review](#versioning--review).

---

## System Context & Trust-Boundary Map

This section is the maintained, versioned view of every trust boundary in the
system. Each boundary names the components on either side, the owning code, and
the data flows that cross it. When you change a boundary, update this map and
bump the document version (see [Versioning & Review](#versioning--review)).

### Components

| Component | Description | Owning code |
|-----------|-------------|-------------|
| **Browser** | Untrusted frontend SPA running in the user's browser. | `frontend/` |
| **Wallet** | User-controlled signer (e.g. Freighter). Holds user keys; never shares them. | `frontend/` wallet integration |
| **API** | Backend HTTP/SSE server. Authenticates requests, enforces authorization. | `backend/src/index.ts`, `backend/src/routes/`, `backend/src/controllers/` |
| **Worker** | Background indexer polling Soroban RPC and persisting events. | `backend/src/workers/soroban-event-worker.ts`, `backend/src/workers/index.ts` |
| **Database** | PostgreSQL via Prisma. Canonical persistence for streams and events. | `backend/prisma/schema.prisma` |
| **RPC** | Soroban RPC endpoint used to read chain state and submit transactions. | `backend/src/services/sorobanService.ts` |
| **External provider** | Third-party services (Redis Pub/Sub, notification/email providers). | `backend/src/services/sse.service.ts`, notification services |

### Trust Boundaries

Each boundary is a place where data crosses from a less-trusted to a
more-trusted domain (or vice versa). Authorization and validation MUST be
enforced at the boundary, not assumed from the caller.

| ID | Boundary | Trusted side | Untrusted side | Owning code | Data flows |
|----|----------|--------------|----------------|-------------|------------|
| **TB-1** | Browser → API | API | Browser | `backend/src/middleware/`, `backend/src/routes/` | HTTP requests (auth tokens, stream IDs, amounts). API MUST authenticate and authorize every mutating request. |
| **TB-2** | Wallet → RPC | RPC / chain | Wallet | `frontend/` wallet integration, `backend/src/services/sorobanService.ts` | Wallet-signed transactions (create, withdraw, pause, resume). Backend never holds user keys. |
| **TB-3** | API → RPC (custodial) | RPC / chain | API | `backend/src/services/sorobanService.ts` (`topUpStream`) | Server-signed top-up transactions using `KEEPER_SECRET_KEY`. Only top-up is custodial. |
| **TB-4** | Worker → RPC | RPC / chain | Worker | `backend/src/workers/soroban-event-worker.ts` | Read-only polling of contract events; XDR decoded and validated before persistence. |
| **TB-5** | Worker → Database | Database | Worker | `backend/src/workers/soroban-event-worker.ts`, `backend/prisma/schema.prisma` | Upserts of `Stream` / `StreamEvent`, cursor advance on `IndexerState`. |
| **TB-6** | API → Database | Database | API | `backend/src/controllers/`, `backend/src/services/indexerService.ts` | Reads/writes of stream state and indexer control-plane operations. |
| **TB-7** | API → External provider (Redis) | External provider | API | `backend/src/services/sse.service.ts` | SSE fanout via Redis Pub/Sub (`sse:stream:*`, `sse:user:*`). |
| **TB-8** | API → Browser (SSE) | Browser | API | `backend/src/services/sse.service.ts` | Server-Sent Events pushed to subscribed clients. Clients receive only events they are authorized to see. |

### Data Flow Overview

```
[Browser] --TB-1--> [API] --TB-6--> [Database]
   |                  |  \--TB-3--> [RPC] <--TB-2-- [Wallet]
   |                  |  \--TB-7--> [External provider: Redis]
   |<----TB-8---------|
                      |
[Worker] --TB-4--> [RPC]
[Worker] --TB-5--> [Database]
```

### Boundary Rules

1. **TB-1 (Browser → API):** Never trust client-supplied identity or amounts;
   re-derive authorization from the authenticated session.
2. **TB-2 (Wallet → RPC):** User keys never leave the wallet. The backend must
   not request or store them.
3. **TB-3 (API → RPC custodial):** `KEEPER_SECRET_KEY` is used only by
   `topUpStream`. Do not wire other mutating actions to a server-side submit
   path (see [Keeper-Key Authorization Model](#keeper-key-authorization-model)).
4. **TB-4/TB-5 (Worker):** Validate decoded XDR before persisting; dedup via
   `@@unique([transactionHash, eventType])`.
5. **TB-7/TB-8 (SSE):** Broadcast only to authorized subscribers; admin events
   are scoped to `ADMIN_PUBLIC_KEY`.

---

## Versioning & Review

This document is versioned. The version is declared at the top of the file
(`**Document version:**`) and MUST be bumped whenever a trust boundary, owning
code path, or data flow changes.

**Lightweight review process:**

1. Any PR that adds, removes, or moves a trust boundary, or changes the owning
   code path of an existing boundary, MUST update this document in the same PR.
2. Reviewers verify that every boundary row links to a real owning code path and
   that the data-flow diagram matches the table.
3. Bump the document version (semver: major for boundary removal/trust-model
   change, minor for new boundary, patch for path/link fixes).
4. The `backend/docs/ARCHITECTURE.md` file is the single maintained view; do not
   duplicate the boundary map elsewhere.

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
