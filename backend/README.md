# Backend

This directory contains the backend services for the StreamPay platform.

## Structure

- `src/` — application source code
- `docs/` — architecture, API versioning, and operational documentation
- `e2e/` — end-to-end and testnet helpers
- `examples/` — example client integrations

## Integrations

### Subscription billing adapter

The billing adapter (`src/integrations/billing/`) is the integration boundary
between external billing systems (e.g. Stripe-style subscription providers) and
on-chain streams. It exposes two responsibilities:

1. **Create or update streams** from billing subscription events.
2. **Reconcile** billing record status against on-chain stream events.

#### Reconciliation keys

Every billing record is linked to a stream through an explicit reconciliation
key so that billing and on-chain state can always be matched:

| Billing field        | On-chain field      | Purpose                                   |
| -------------------- | ------------------- | ----------------------------------------- |
| `subscriptionId`     | `stream.metadata.subscriptionId` | Primary reconciliation key |
| `invoiceId`          | `stream.metadata.invoiceId`      | Idempotency key for invoice events |
| `providerEventId`    | —                   | Dedupe key for raw webhook delivery |

#### Duplicate-invoice behavior

Invoice events are **idempotent**. The adapter keys on `invoiceId` (falling
back to `providerEventId` when no invoice is present):

- A repeated `invoice.paid` for an already-applied invoice is a no-op and
  returns the existing stream reference.
- A repeated `invoice.payment_failed` does not re-open or re-close a stream that
  has already transitioned for that invoice.
- Conflicting events for the same `invoiceId` (e.g. `paid` after `voided`) are
  rejected and surfaced as a divergence for manual resolution rather than
  silently overwriting state.

#### Out-of-order webhooks

Webhooks may arrive out of order. Each billing event carries a monotonic
`sequence` (and `occurredAt` timestamp). The adapter applies events
**deterministically**:

- Events with a `sequence` lower than the last applied sequence for a
  subscription are ignored (stale) and logged.
- Events with equal `sequence` are deduped by `providerEventId`.
- Only strictly newer events mutate stream state, so replaying a webhook batch
  in any order converges to the same result.

#### Resolving divergence

When billing and on-chain state disagree (e.g. billing says `active` but the
stream is `ended`), reconciliation reports a `divergence` entry containing the
reconciliation key, the billing status, and the on-chain status. Resolution:

1. Inspect the divergence report from `reconcile()`.
2. Confirm the authoritative source (on-chain state is authoritative for stream
   lifecycle; billing is authoritative for invoice/payment status).
3. Re-issue the corrective billing event with a newer `sequence`, or, for
   on-chain drift, create a compensating stream update. Never weaken wallet
   authorization or chain/network validation to force a match.

See `docs/ARCHITECTURE.md` for the broader event flow and `docs/API_VERSIONING.md`
for versioning guarantees of the adapter's public interface.
