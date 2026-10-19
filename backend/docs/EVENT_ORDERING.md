# Event Ordering Guarantees

This document specifies the ordering guarantees that FlowFi provides for stream
lifecycle events, and describes how those guarantees are enforced across the
database, indexer worker, and SSE delivery layers.

## Stream Lifecycle Order

Stream events follow a strict state-machine lifecycle on the Stellar network:

```
CREATED
  └──> TOPPED_UP       (repeatable — sender adds more funds)
  └──> WITHDRAWN       (repeatable — recipient withdraws earned funds)
  └──> PAUSED          (sender pauses the stream)
       └──> RESUMED    (sender resumes the stream)
  └──> CANCELLED       (terminal — sender cancels early)
  └──> COMPLETED       (terminal — stream reaches its natural end)
```

Additional protocol-level events (`FEE_COLLECTED`, `FEE_CONFIG_UPDATED`,
`ADMIN_TRANSFERRED`) are emitted by the contract admin and are not bound to
any individual stream lifecycle.

A `CREATED` event **must** appear before any other lifecycle event for the
same `streamId`. `CANCELLED` and `COMPLETED` are terminal — no further
lifecycle events are valid after either is received.

## Canonical Ordering Key

The canonical order of events is determined by two fields, in priority order:

| Priority | Field            | Type   | Description                                                                |
|----------|------------------|--------|----------------------------------------------------------------------------|
| 1        | `ledgerSequence` | `Int`  | Stellar ledger number. Strictly increasing; globally unique per ledger.    |
| 2        | `id`             | `UUID` | Database row UUID. Tiebreaker within the same ledger (insertion order).    |

`timestamp` (Unix integer set at indexing time) is **not** used as a sort key
for ordering queries because:

- Multiple events in the same ledger may share the same indexer wall-clock
  timestamp.
- Timestamp can skew slightly between concurrent indexer replicas.
- `ledgerSequence` is the only value that reflects Stellar's finality order.

## Database Enforcement

### Idempotency Constraint

```sql
UNIQUE (transactionHash, eventType)
```

Added by migration `20260428000001_add_stream_event_unique_constraint`. This
unique constraint prevents a replayed or double-indexed event from inserting a
duplicate row — the `upsert` in each event handler will hit the constraint and
fall through to the `update` branch instead of inserting a second row.

### Ordering Indices

| Index name                                | Columns                         | Purpose                                                        |
|-------------------------------------------|---------------------------------|----------------------------------------------------------------|
| `StreamEvent_streamId_timestamp_idx`      | `(streamId, timestamp)`         | Calendar/date-range queries for a specific stream.             |
| `StreamEvent_streamId_ledgerSequence_idx` | `(streamId, ledgerSequence)`    | Canonical lifecycle ordering queries. Added by migration `20261019000000_add_event_sequence_ordering`. |
| `StreamEvent_streamId_eventType_idx`      | `(streamId, eventType)`         | Filtering events of a specific type for a stream.              |

The `(streamId, ledgerSequence)` index is used by all queries that list or
paginate events in lifecycle order. The planner will also use it for `ORDER BY
ledgerSequence DESC` to serve reverse-chronological listings without a sort.

## API Query Ordering

All paginated event-listing endpoints sort by `(ledgerSequence, id)`:

- **Forward / chronological** (`order=asc`): `ORDER BY ledgerSequence ASC, id ASC`
- **Reverse / newest-first** (`order=desc`): `ORDER BY ledgerSequence DESC, id DESC`

This is enforced in `src/repositories/streamEvent.repository.ts` →
`listEventsForWallet`. Cursor-based pagination (`nextCursor`) is consistent
with this ordering: the cursor points at the last returned `id` and the next
page resumes from the row immediately after it in the same sort order.

## Indexer Worker Ordering

The Soroban event worker (`src/workers/soroban-event-worker.ts`) receives a
batch of up to 100 events per poll cycle from the RPC node. Before processing,
the batch is sorted by:

1. **Ledger sequence ASC** — events in earlier ledgers are always applied first.
2. **`stream_created` before all other types within the same ledger** — ensures
   the `Stream` row is written to the database before any downstream event
   handler (e.g. `TOPPED_UP`, `FEE_COLLECTED`) tries to insert a row that
   references it via the foreign key.
3. **Soroban paging token (`event.id`) ASC** — within the same ledger and
   event-type group, paging tokens encode `(ledger, txIndex, eventIndex)` and
   are lexicographically ordered, which preserves transaction ordering.

This multi-level sort is implemented in `runPollCycle` and applies to both
the outer per-event loop and the batched `persistEventBatch` path.

## SSE Delivery and Out-of-Order Detection

Every SSE message broadcast by the indexer includes an `_ordering` object that
clients can use to detect out-of-order or duplicate delivery:

```jsonc
{
  "streamId": "42",
  "transactionHash": "abc123...",
  "ledger": 12345678,
  "_ordering": {
    "ledgerSequence": 12345678,
    "eventId": "0000000012345678-0000000002-0000000001",
    "eventType": "TOPPED_UP"
  }
}
```

| Field                       | Description                                                           |
|-----------------------------|-----------------------------------------------------------------------|
| `_ordering.ledgerSequence`  | Stellar ledger number. Compare with the last received value.          |
| `_ordering.eventId`         | Soroban paging token. Lexicographic order = canonical chain order.    |
| `_ordering.eventType`       | Upper-cased event type (e.g. `"TOPPED_UP"`).                          |

### Client-Side Reordering Pattern

```typescript
let lastLedger = 0;
let lastEventId = "";

evtSource.addEventListener("stream.topped_up", (e) => {
  const payload = JSON.parse(e.data);
  const { ledgerSequence, eventId } = payload._ordering;

  if (
    ledgerSequence < lastLedger ||
    (ledgerSequence === lastLedger && eventId <= lastEventId)
  ) {
    // Out-of-order or duplicate — discard or buffer for resequencing.
    return;
  }

  lastLedger = ledgerSequence;
  lastEventId = eventId;
  applyEvent(payload);
});
```

SSE connections are multiplexed through Redis pub/sub in multi-replica
deployments. Because each replica advances the cursor independently (fenced by
the lease), every replica publishes to the same Redis channels in the same
canonical order — clients will not see gaps or duplicates when reconnecting,
provided they resume from their last `_ordering.eventId`.

## Replay and Idempotency

The indexer supports cursor-based replay (`npm run indexer:replay`). Replay is
idempotent because:

1. `upsert` on `(transactionHash, eventType)` skips rows that already exist.
2. The `(streamId, ledgerSequence)` index ensures re-fetched events land in the
   correct position for subsequent reads without manual resorting.
3. Dead-lettered events that are replayed via the admin API are processed
   through the same `processEvent` path, which checks for duplicates before
   mutating stream state.

## Summary of Guarantees

| Layer       | Guarantee                                                                 |
|-------------|---------------------------------------------------------------------------|
| Database    | Unique constraint prevents duplicate rows per `(txHash, eventType)`.      |
| Database    | `(streamId, ledgerSequence)` index enables O(log n) ordered scans.        |
| API queries | All event-listing responses are sorted by `(ledgerSequence ASC, id ASC)`. |
| Indexer     | Batch events are processed in ledger+paging-token order.                  |
| SSE         | Every broadcast includes `_ordering.{ledgerSequence, eventId, eventType}` for client-side gap detection. |
