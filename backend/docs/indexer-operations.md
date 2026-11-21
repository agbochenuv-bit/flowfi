# Indexer Operations

This document describes how the indexer ingests stream lifecycle events and how
scheduled stream activation and expiry affect indexing, accrual calculations, and
operator expectations.

## Timestamp units

All stream timestamps (`start_time`, `end_time`, `paused_at`, `cancelled_at`) are
**Unix epoch seconds** (UTC), stored as `u64`. They are compared against the
ledger close time of the transaction that touches the stream. Off-chain client
calculations MUST use the same unit and the same boundary rules described below
so that indexed accrual matches on-chain accrual exactly.

## Scheduled activation and expiry

A stream may declare:

- `start_time` — the ledger timestamp at which accrual begins. A stream created
  with a future `start_time` is **scheduled** and does not accrue before it.
- `end_time` (optional) — the ledger timestamp after which accrual stops. When
  omitted, the stream accrues until cancelled or fully withdrawn.

### Boundary behavior

Accrual for a stream is computed over the half-open interval
`[max(start_time, last_checkpoint), min(end_time, now)]`. The indexer MUST apply
these rules consistently:

| Case | Behavior |
| --- | --- |
| Before start (`now < start_time`) | Accrued amount is `0`. No accrual event is emitted. |
| Exact start (`now == start_time`) | Accrual begins; interval length is `0` at this instant, so accrued is `0` but the stream is considered active. |
| During window | Accrual is `rate * (now - max(start_time, last_checkpoint))`, capped at `end_time`. |
| Exact end (`now == end_time`) | Accrual stops at `end_time`; the full window up to `end_time` is accrued. |
| After end (`now > end_time`) | No further accrual. Late claims settle only up to `end_time`. |
| Late claim | A claim submitted after `end_time` (or after cancellation) settles the accrued amount up to the effective stop time; no accrual is generated for the gap. |

### Pause / resume

- Pausing before `start_time` records `paused_at` but does not accrue anything;
  on resume, accrual still cannot begin before `start_time`.
- Pausing during the window stops accrual at `paused_at`. On resume, accrual
  restarts from the resume time, never retroactively covering the paused gap.
- Pausing at or after `end_time` is a no-op for accrual; the stream is already
  expired.

### Cancellation

- Cancelling before `start_time` terminates the stream with `0` accrued.
- Cancelling during the window accrues up to `cancelled_at` (bounded by
  `end_time`).
- Cancelling at or after `end_time` accrues up to `end_time` only.

## Indexer handling

- Index `StreamCreated` with `start_time`/`end_time` as declared; do not treat a
  future `start_time` as an error.
- Emit accrual checkpoints only for intervals with positive length inside the
  active window.
- When replaying events, recompute accrual using ledger close times, not wall
  clock time, so scheduled activation and expiry are deterministic.
- Treat `end_time <= start_time` as invalid at creation; the indexer should flag
  such events as malformed rather than indexing them.

## Transaction behavior

- Creating a scheduled stream is a normal transaction; it succeeds regardless of
  whether `start_time` is in the future.
- Claims, pauses, resumes, and cancellations are ordinary transactions whose
  effects are bounded by the active window as described above.
- No transaction is required to "activate" a scheduled stream; activation is
  purely time-based and derived from ledger close time.
