# ADR 0005: Event Ordering Guarantees

- Status: Accepted
- Date: 2026-10-19
- Deciders: FlowFi core (backend + contracts)
- Related: `backend/src/workers/soroban-event-worker.ts`,
  `backend/src/repositories/streamEvent.repository.ts`,
  `backend/src/controllers/stream.controller.ts`,
  `backend/tests/event-ordering.test.ts`

## Context

FlowFi indexes Soroban contract events (`stream_created`, `stream_topped_up`,
`tokens_withdrawn`, `stream_paused`, `stream_resumed`, `stream_cancelled`,
`stream_completed`, `fee_collected`) into Postgres and fans them out over SSE.
Clients (payroll dashboards, recipients) need a deterministic ordering to
reconstruct stream lifecycle state correctly. Without a documented contract,
each query path picked its own sort key (`timestamp`, `createdAt`, etc.),
leading to inconsistent results and fragile cursor pagination — `timestamp` is
wall-clock time set at indexing time and can collide or skew for events in the
same ledger, making the sort non-deterministic under concurrent indexer
replicas.

## Decision

### Canonical order

The canonical event order is **`(ledgerSequence ASC, eventId ASC)`**.

- `ledgerSequence` — the Soroban ledger sequence number. No two events in
  different ledgers share a sequence number, so this provides a strict
  cross-ledger total order matching on-chain finality.
- `eventId` — the Soroban paging token, formatted as
  `<ledger>-<txIndex>-<eventIndex>`. Lexicographic comparison preserves
  transaction and event index ordering within a ledger.

### Persistence layer

Events are sorted into canonical order **before** writing in
`runPollCycle` (`soroban-event-worker.ts`):

1. `ledgerSequence ASC`
2. `stream_created` first within the same ledger (so the `Stream` row exists
   before any `topped_up` / `fee_collected` event references it via foreign key)
3. `eventId ASC` (Soroban paging token)

Persistence uses idempotent `upsert` with a `@@unique([transactionHash, eventType])`
duplicate guard, so replays never re-write or re-broadcast an event.

### DB query layer

All `findMany` calls that return events to API clients sort by
`[{ ledgerSequence: order }, { id: order }]`:

- `listEventsForWallet` — wallet-scoped event listing
- `listEventsForStream` — stream-scoped event listing
- `getStreamEvents` (`stream.controller.ts`) — direct controller query

`order` is `asc` or `desc` based on the client's request (default `desc`).
`id` (UUID v4) is the stable unique tiebreaker for cursor pagination.

### Redis fanout

SSE fanout happens **after** the DB transaction commits. Within a processed
batch, events are broadcast in canonical order (the batch was already sorted
before persistence). Each SSE payload carries `_ordering` metadata:

```json
{
  "_ordering": {
    "ledgerSequence": 123456,
    "eventId": "123456-0000000001-0000000001",
    "eventType": "CREATED"
  }
}
```

Redis pub/sub does **not** guarantee delivery order across messages, and SSE
connections may drop and reconnect, so clients must not assume arrival order
equals canonical order.

### Within-ledger rule

`stream_created` is always processed before other event types in the same
ledger. This is enforced by the secondary sort key in `runPollCycle` and
ensures the `Stream` row exists before any dependent event (e.g.
`fee_collected`, `stream_topped_up`) tries to reference it.

### Cross-ledger guarantee

Lower ledger sequences are always applied before higher ledger sequences.
This is enforced by the primary sort key in `runPollCycle` and by the DB
query layer's `ledgerSequence` ordering.

### Client guidance

Clients receiving SSE events that need strict ordering guarantees should
re-sequence by `_ordering.ledgerSequence` then `_ordering.eventId` after
collecting events. SSE delivery may be reordered by Redis pub/sub or
connection drops; the `_ordering` metadata lets clients detect and correct
out-of-order delivery without trusting arrival order.

## Consequences

Positive:

- One canonical ordering across persistence, query, and fanout layers.
- Stable cursor pagination (the `id` tiebreaker is unique).
- Replays are safe: the duplicate guard prevents re-writes and re-broadcasts.
- Clients can reconstruct correct lifecycle state even with reordered SSE.

Negative / residual:

- `timestamp` is still persisted (for human-readable display) but is no longer
  a sort key. Any code that relied on `timestamp` ordering must migrate to
  `ledgerSequence`.
- The `stream_created`-first rule is only enforced in the worker's sort;
  direct DB queries do not reorder by event type within a ledger (accepted:
  API consumers sort by ledger sequence, not lifecycle dependency).

## Alternatives considered

| Alternative | Why rejected |
|---|---|
| `timestamp` as sole sort key | Wall-clock collisions in same ledger; non-deterministic under concurrent replicas |
| `createdAt` (DB insert time) as sort key | Reflects indexer timing, not chain order; changes on replay |
| Per-event-type priority in DB queries | Only needed at ingestion (FK dependency); adds complexity to read path for no reader benefit |
| No `_ordering` metadata on SSE | Clients cannot detect/recover from pub/sub reordering |
