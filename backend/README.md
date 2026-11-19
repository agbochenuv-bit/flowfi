# FlowFi Backend

This document describes the backend services, their public interfaces, and the
operational contracts they must uphold. Keep it in sync with code changes that
alter externally observable behavior.

## Accounting export adapters

The accounting export adapters map FlowFi stream and event records to a
documented accounting interchange format (a JSON journal of balanced entries)
without losing ledger or transaction provenance. They live under
`backend/src/integrations/accounting/` and are consumed by the export job and
partner integrations.

### Stable identifiers

Every exported entry carries stable identifiers so downstream ledgers can
deduplicate and reconcile across re-exports:

- `streamId` — the FlowFi stream identifier (unchanged across lifecycle).
- `eventId` — the originating event identifier; unique per lifecycle event.
- `entryId` — deterministic, derived from `(streamId, eventId, entryKind)` so
  re-running an export produces identical identifiers.
- `txHash` / `network` — chain provenance, preserved verbatim when present.

Identifiers are never regenerated from timestamps or array positions.

### Rounding

- All monetary amounts are exported as integer minor units (e.g. cents) using
  the token/asset decimals recorded on the stream.
- Rounding is half-up (`ROUND_HALF_UP`) applied once, at the point of
  conversion from on-chain base units to the export minor unit.
- No intermediate rounding is performed; sums are computed in base units and
  converted once to avoid drift.
- The rounding mode and scale are recorded on each export batch header.

### Fees

- Protocol and network fees are exported as separate debit entries linked to
  the parent stream entry via `entryId`/`parentEntryId`.
- Fees are never netted into the principal amount; provenance of each fee is
  retained (`feeKind`, `txHash`).
- Zero-fee events emit no fee entry.

### Timezone

- All timestamps are normalized to UTC and exported as RFC 3339 with a `Z`
  suffix.
- The source timezone (if any) is not inferred; records without a timestamp
  are rejected rather than defaulted.
- Export batch headers record `timezone: "UTC"`.

### Reversal entries

- Reversals (cancellations, refunds, failed settlements) emit a compensating
  entry that references the original via `reversesEntryId`.
- Reversal entries negate the original amount and reuse the original
  `streamId`/`txHash` provenance; they never mutate the original entry.
- A reversal without a resolvable original entry is a hard failure.

### Testing

- Golden-file tests under `backend/test/integrations/accounting/golden/` cover
  representative lifecycle histories (create → fund → withdraw → cancel,
  fee-bearing settlements, and reversals).
- Focused unit tests cover boundary cases: zero amounts, maximum decimals,
  missing timestamps, unresolvable reversals, and duplicate re-exports.

## Compatibility

Existing export interfaces remain backward compatible. Any breaking change to
the interchange format must be versioned via the batch header `schemaVersion`.
