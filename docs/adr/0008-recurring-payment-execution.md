# 0008. Recurring payment execution

## Status

Proposed. Contract and backend owners must both approve before implementation. Review findings and the final decision belong in this record.

## Context

A recurring schedule describes multiple future payments. Existing streams represent funded on-chain commitments. Scheduling, approval, and ledger settlement need separately observable states.

## Decision proposed

Store schedule ownership, UTC cadence, immutable occurrence terms, and execution state in the backend. Start with an off-chain scheduler that prepares an intent and asks the wallet owner to sign a discrete on-chain payment. Use server-side schedule ownership checks for edits, pause and cancellation, and require wallet authorization for each transaction. A schedule cancellation suppresses future preparation. Existing on-chain streams keep their contract lifecycle.

Use a unique database constraint on schedule and UTC occurrence time. Atomically create or reuse the occurrence when the scheduler retries. Preserve the approved terms on each prepared occurrence and apply edits to future, unprepared occurrences. Default to skipping missed occurrences and rejecting a second dispatch for a pending occurrence. Persist the network and submitted transaction hash before retrying delivery. Reconcile ambiguous outcomes on that network and issue a new signed attempt only after the earlier attempt is known to have failed or expired without execution.

## Alternatives considered

| Option | Trade-off |
| --- | --- |
| Off-chain scheduling and per-payment signing | Reuses wallet authorization and existing contracts. Payment can be delayed when the signer is unavailable. |
| Prefunded on-chain recurring schedule | Can enforce caps and cadence on-chain. Requires a contract feature, escrow and refund semantics, and a caller to trigger due occurrences. |
| Keeper with delegated signing authority | Can run unattended. Requires enforceable spending bounds, revocation, recovery, monitoring, and a separate custody review. |

## Consequences and migration

Add schedules and occurrences as new records. Existing one-off streams need no backfill. Expose schedules through new endpoints alongside existing stream APIs and preserve history after edits. For rollout and rollback, gate new scheduling and keep reconciliation running for submitted occurrences. Moving to prefunded execution later requires explicit wallet opt-in and an audited cutover that stops off-chain dispatch before activating the replacement schedule.

Before accepting, contract and backend owners should verify concurrent scheduling, UTC boundaries, missed payments, schedule edits, wallet rejection, and lost submission responses. The [organization proposal](0007-organization-ownership.md) applies when the schedule belongs to an organization. Follow the [client signing decision](0002-keeper-key-deprecation-client-side-signing.md).
