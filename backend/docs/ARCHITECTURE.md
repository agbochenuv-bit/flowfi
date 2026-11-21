# Backend Architecture

This document is the canonical reference for backend service architecture. It is
referenced by `backend/src/services/indexerService.ts` and
`backend/src/services/soroban-indexer.service.ts` as the authoritative source for
indexer ownership, SSE broadcast flow, and keeper-key authorization.

For the full project-wide architecture (event type data flows, pause/resume
timing, environment variables, and operational runbook) see
[`docs/ARCHITECTURE.md`](../../docs/ARCHITECTURE.md).

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

## Verifier-Backed Conditional Release Policies

Some streams gate accrual or release on the result of an external verifier
(e.g. an oracle, attestation service, or off-chain job runner). This section
defines the trust model and failure semantics for those streams. The interface
is additive: streams without a configured verifier keep the existing
unconditional accrual/release behavior.

### Verifier Identity

- A verifier is identified by a stable `verifierId` (opaque string) plus the
  on-chain `verifierAddress` that is authorized to submit results. Both are
  configured at stream creation and are immutable for the life of the stream.
- Only results whose `verifierAddress` matches the stream's configured address
  are accepted. Results from any other address are rejected and never mutate
  stream state.
- The backend treats the verifier as an **untrusted external input**: it
  validates identity and shape, but does not assume the verifier is honest or
  available.

### Trust Assumptions

> **The verifier is trusted only to report its own result — not to move funds,
> change stream parameters, or bypass wallet authorization.** Release still
> requires the normal wallet-signed withdraw path; the verifier result only
> determines *whether* accrual/release is permitted, never *who* may trigger it.

- Verifier results are advisory gates. They cannot weaken wallet authorization,
  chain/network validation, or financial accounting invariants.
- The verifier's correctness (e.g. whether a job truly succeeded) is outside the
  protocol's trust boundary; the protocol only enforces that a result came from
  the configured verifier and was well-formed.

### Timeout, Failure, and Replay Semantics

| Condition | Behavior |
|-----------|----------|
| **No result yet** | Stream accrues/releases per its default policy until a valid result arrives. |
| **Timeout** | If no valid result arrives within the configured `verifierTimeoutSeconds`, the stream falls back to its configured failure mode (see below). |
| **Verifier unavailable** | Treated as a timeout once the deadline passes; the failure mode applies. |
| **Malformed response** | Rejected without mutating state; the stream remains in its pre-result state and the timeout clock continues. |
| **Wrong verifier identity** | Rejected without mutating state (same as malformed). |
| **Replay / duplicate result** | Results are keyed by `(streamId, verifierId, nonce)`. A result whose nonce was already consumed is ignored; it never re-triggers release. |

**Failure modes** (configured per stream):

- `block` — accrual/release is blocked until a valid result arrives (default).
- `release` — accrual/release proceeds as if the verifier returned success.

### Operational Notes

- Malformed or unavailable verifier responses are logged with the stream ID and
  verifier ID but never surface raw verifier payloads to clients.
- The timeout boundary is inclusive of the deadline: a result arriving exactly at
  `verifierTimeoutSeconds` is accepted; anything later is treated as a timeout.
- Replay protection relies on the consumed-nonce set; operators must not reuse
  nonces when re-submitting results.
