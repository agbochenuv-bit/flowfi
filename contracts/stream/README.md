# Stream Contract

This document describes the stream contract's public interface, its
invariants, and the operational rules that callers must follow.

## Overview

A stream accrues value at a fixed rate from a start time until it is
withdrawn or cancelled. The sender funds the stream; the recipient
withdraws accrued value. Pause/resume and cancellation are supported.

## Rate amendments

Active streams support **bilateral rate amendments**: the sender and the
recipient may agree to change the accrual rate for the remainder of the
stream while preserving all value accrued under the previous rate.

### Consent rules

- An amendment requires approval from **both** the sender and the
  recipient. A single-sided approval never takes effect.
- Approvals are recorded per amendment id. Each party may approve at most
  once per amendment; a second approval from the same party is rejected.
- The amendment becomes effective only once both approvals are present.

### Effective-time rules

- The new rate applies **only from a future effective timestamp**
  (`effectiveAt > now`). Amendments with `effectiveAt <= now` are
  rejected.
- Value accrued before `effectiveAt` is settled at the **previous** rate
  and is never recomputed under the new rate.
- Accrual after `effectiveAt` uses the new rate. Rounding is applied per
  accrual segment (previous-rate segment and new-rate segment are rounded
  independently) so that no value is created or destroyed across the
  boundary.
- Pause/resume interacts with amendments as follows: while paused, no
  value accrues under either rate; on resume, accrual continues at the
  rate in effect at the resume timestamp. An amendment whose
  `effectiveAt` falls inside a paused window takes effect at resume.

### Stale-state rules

- Each amendment references the stream state version it was proposed
  against. If the stream's current version differs (e.g. the stream was
  paused, resumed, cancelled, or another amendment was applied), the
  amendment is **stale** and is rejected.
- Stale amendments must be re-proposed against the current version.

### Replay rejection

- Amendment ids are single-use. Re-submitting an amendment id that has
  already been applied or rejected is rejected.
- Replayed approvals (same party, same amendment id) are rejected as
  described in the consent rules.

### Events

Applying an amendment emits an amendment event containing at minimum:

- `streamId`
- `amendmentId`
- `previousRate`
- `newRate`
- `effectiveAt`
- `stateVersion` (the version the amendment was applied against)

## Invariants

- Total withdrawn value never exceeds total accrued value.
- Value accrued under a previous rate is preserved across amendments.
- Only the sender may fund or cancel; only the recipient may withdraw.
- Wallet authorization and chain/network validation are never weakened
  by amendments.
