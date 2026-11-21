# Stream Contract

The stream contract lets a funder create a stream that pays a recipient over time.
Each stream is independently funded, uniquely identified, and independently
cancellable.

## Streams

- `create_stream(funder, recipient, amount, start, duration)` — creates a single
  stream instance. The funder must authorize the call and have sufficient
  balance; the stream is identified by a unique stream id.
- `cancel_stream(stream_id)` — cancels a single stream instance. Only the funder
  (or an authorized party) may cancel, and only that instance is affected.
- `withdraw(stream_id)` — withdraws the vested amount for a single instance.

## Recurring schedules

A recurring schedule spawns successive stream instances from a bounded
schedule. Each generated instance is a normal stream: independently funded,
uniquely identified, and independently cancellable. Cancelling one instance
never affects its siblings.

### Schedule parameters

A schedule is defined by:

| Field        | Meaning                                                        |
| ------------ | -------------------------------------------------------------- |
| `interval`   | Seconds between successive instance start times.               |
| `start`      | Start time of the first instance.                              |
| `count`      | Maximum number of instances the schedule may create.           |
| `amount`     | Amount funded per instance.                                    |
| `duration`   | Duration of each instance.                                     |

### Limits

Schedules are bounded so that a single schedule cannot create unbounded work:

- `interval` must be within `[MIN_INTERVAL, MAX_INTERVAL]`.
- `count` must be within `[1, MAX_INSTANCES]`.
- `amount` must be greater than zero.

Schedules outside these bounds are rejected at creation time.

### Deterministic linkage

Each instance created by a schedule is deterministically linked to its parent
via `(schedule_id, index)`, where `index` is the zero-based position of the
instance in the schedule. The instance id is derived from this pair, so the same
schedule and index always map to the same instance id. This makes duplicate
execution idempotent: attempting to create an instance that already exists is
rejected rather than creating a second stream.

### Missed intervals

If execution is delayed, missed intervals are **skipped**, not caught up. Only
the instance for the current interval index is created; earlier missed indices
are not retroactively created. This keeps accounting deterministic and avoids
unexpected bulk funding.

### Insufficient funding

Each instance is funded independently. If the funder lacks sufficient balance
for the next instance, creation of that instance fails and the schedule does not
advance. Previously created instances are unaffected.

## Rate and duration ceilings

Protocol policy may bound the per-stream rate and duration so that accidental or
abusive configurations cannot be created. The ceilings are configurable by the
policy owner and are enforced only on the stream creation path.

### Units

| Policy field     | Unit                                                          |
| ---------------- | ------------------------------------------------------------- |
| `max_rate`       | Token base units per second (rate = `amount / duration`).     |
| `max_duration`   | Seconds.                                                      |

A stream's rate is derived from its `amount` and `duration`; a stream is
rejected when its derived rate exceeds `max_rate` or its `duration` exceeds
`max_duration`. Configurations exactly at a ceiling are accepted; only values
strictly above a ceiling are rejected.

### Policy-change behavior

Ceilings apply **only to newly created streams**. Streams that already exist
retain the terms they were created with, even if a later policy change would
make those terms exceed the new ceilings. Lowering a ceiling never mutates,
cancels, or truncates existing streams; it only prevents future creations that
exceed the new bounds.

### Errors

Creation that exceeds either ceiling is rejected with a clear contract error
(`RateExceedsCeiling` / `DurationExceedsCeiling`) rather than silently clamping
the configuration.

## Fee rebates

Eligible stream operations may receive a bounded fee rebate. Rebates are
optional: when no rebate policy is configured, or when an operation is not
eligible, the full fee is charged and no rebate is applied.

### Eligibility

An operation is eligible for a rebate only when **all** of the following hold:

- the operation is a stream creation or withdrawal on an existing stream;
- the stream's derived rate is at or below `rebate_max_rate`;
- the stream's `duration` is at or below `rebate_max_duration`;
- the operation's fee is greater than zero.

Operations that fail eligibility (for example, a rate or duration above the
rebate ceilings, or a zero fee) receive no rebate. Eligibility is evaluated
against the same terms used at creation time and is never retroactively
re-evaluated for existing streams.

### Rebate cap and rounding

| Policy field          | Meaning                                                    |
| --------------------- | ---------------------------------------------------------- |
| `rebate_bps`          | Rebate rate in basis points of the fee (0–`MAX_REBATE_BPS`).|
| `rebate_max_amount`   | Absolute maximum rebate per operation, in base units.      |
| `rebate_max_rate`     | Maximum stream rate eligible for a rebate.                 |
| `rebate_max_duration` | Maximum stream duration eligible for a rebate.             |

The rebate is computed deterministically as
`rebate = min(fee * rebate_bps / 10_000, rebate_max_amount)`, using integer
arithmetic that **rounds down**. Rounding down guarantees the rebate never
exceeds the fee and never exceeds `rebate_max_amount`. `rebate_bps` is capped at
`MAX_REBATE_BPS` (10_000, i.e. 100%); configurations above the cap are rejected
at policy update time.

### Conservation and treasury accounting

Rebates preserve conservation of funds: the recipient is credited the net
amount (`fee - rebate`) and the rebate is recorded as a treasury adjustment, so
the sum of credited amounts and treasury adjustments always equals the total fee
collected. A rebate never mints funds and never reduces the stream's principal.

Applying a rebate emits accounting events so the adjustment is auditable:

- `FeeRebateApplied { stream_id, fee, rebate }` — emitted when a rebate is
  applied to an operation.
- `TreasuryAdjusted { amount }` — emitted for the treasury adjustment matching
  the applied rebate.

When no rebate is applied (ineligible operation, zero fee, or zero rebate after
rounding), neither event is emitted and the full fee is charged.

## Testing

Focused coverage for recurring schedules includes:

- creating successive instances from a valid schedule;
- rejecting schedules with out-of-bounds `interval` or `count`;
- missed intervals being skipped deterministically;
- insufficient funding for an instance failing without advancing the schedule;
- duplicate execution being rejected (deterministic linkage);
- each instance remaining independently cancellable.

Focused coverage for rate and duration ceilings includes:

- accepting a stream exactly at `max_rate` and exactly at `max_duration`;
- rejecting a stream just above `max_rate` or just above `max_duration`;
- accepting a stream just below each ceiling;
- demonstrating that existing streams retain their agreed terms after a policy
  change lowers the ceilings.

Focused coverage for fee rebates includes:

- conservation of funds: credited amount plus treasury adjustment equals the
  total fee collected;
- zero-fee operations applying no rebate and emitting no accounting events;
- ineligible streams (rate or duration above the rebate ceilings) receiving no
  rebate;
- the rebate being capped at `rebate_max_amount` and rounding down;
- `FeeRebateApplied` and `TreasuryAdjusted` events being emitted exactly when a
  rebate is applied.
