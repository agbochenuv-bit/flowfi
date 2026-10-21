# ADR-0005 — Fee Governance Guardrails

| Field | Value |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-10-17 |
| **Authors** | FlowFi core team |
| **Relates to** | Issue #37 |

---

## Context

FlowFi collects a protocol fee on every new stream and every top-up. The fee
rate is expressed in basis points (bps) and is stored in `ProtocolConfig`
alongside the treasury address. Two questions needed an explicit answer before
the contract could be considered production-ready:

1. **Is a zero fee (0 bps) a valid configuration?** Some protocols treat zero
   as an uninitialized / error state. FlowFi must not.
2. **What is the hard upper bound?** Without an enforced cap, the admin could
   set a fee rate that is effectively confiscatory.

---

## Decision

### Zero fee is explicitly permitted

A `fee_rate_bps` of `0` is a valid, intentional configuration — not a sentinel
for "not yet set". Operators may choose to run FlowFi without a fee:

- During an onboarding / growth phase.
- For specific partner integrations where no fee is charged.
- For testing in non-production environments.

The `initialize` and `update_fee_config` entrypoints accept `0` without error.
When `fee_rate_bps == 0`, the full deposited amount is credited to the stream
(`deposited_amount == amount`).

### Hard cap: MAX_FEE_RATE_BPS = 1 000 bps (10%)

The contract constant `MAX_FEE_RATE_BPS = 1_000` establishes a hard ceiling.
Any attempt to set a fee rate above this value — via either `initialize` or
`update_fee_config` — is rejected with `StreamError::InvalidFeeRate`.

A 10% ceiling was chosen because:
- It is generous enough to accommodate any realistic protocol-economics model.
- It prevents a governance attack in which a compromised admin silently
  confiscates most deposited value.
- It is simple to reason about and easy to audit.

### Fee is snapshotted at creation and top-up time

The fee rate stored in `ProtocolConfig` is read **once** at the moment
`create_stream` or `top_up_stream` is executed. The resulting `deposited_amount`
(gross amount minus fee) is written to the `Stream` record and never changes
after that, even if the admin later updates the fee rate.

This means:

- Existing streams are fully isolated from governance changes.
- Recipients can always calculate their entitlement from the `Stream` record
  alone, without needing to track historical fee-rate changes.
- The frontend and SDK can display accurate balances without querying event
  history.

### Only the admin may change fee configuration

`update_fee_config` requires the caller to authenticate as the current admin
(`admin.require_auth()` + `config.admin == admin` check). Neither the treasury
address nor the emergency guardian has any authority over fee governance.

---

## Consequences

### Positive

- Simple, auditor-friendly invariant: look at `Stream.deposited_amount` to know
  exactly how much was deposited net of fees, regardless of subsequent config
  changes.
- Zero-fee operation is a first-class mode, not an edge case that needs special
  handling in the frontend.
- The 10% cap limits worst-case governance damage to a bounded amount.

### Negative / Trade-offs

- There is no time-lock or multi-sig requirement on fee updates. A compromised
  admin key can raise the fee to 10% immediately. Mitigated by the STRIDE threat
  model (separate admin key management) and the hard cap.
- Existing streams are unaffected by fee reductions as well as increases. If
  the fee is lowered, users who created streams at the old (higher) rate do not
  receive a retroactive rebate. This is a deliberate design choice: immutability
  of the fee at creation time is simpler and safer than retroactive adjustments.

---

## Alternatives Considered

### Time-lock on fee updates

Require a minimum delay (e.g., 48 hours) between proposing and applying a fee
change. Rejected for MVP complexity; can be added in a future upgrade without
changing the current guardrail logic.

### Graduated fee table (per-token, per-sender)

Allow different fee rates for different tokens or senders. Rejected: adds
significant complexity and surface area, and the use cases can be addressed via
a zero-fee configuration or separate contract deployments.

### Storing historical fee rates on-chain

Record every fee-rate change so the contract could retroactively apply a lower
fee to old streams. Rejected: significant storage cost with no clear benefit,
given that the snapshot model is already safe and auditable via events.

---

## Related

- `contracts/stream_contract/src/lib.rs` — `update_fee_config`, `MAX_FEE_RATE_BPS`
- `contracts/stream_contract/src/types.rs` — `ProtocolConfig`
- `contracts/stream_contract/src/errors.rs` — `StreamError::InvalidFeeRate`
- `contracts/stream_contract/src/test.rs` — Issue #37 fee governance tests
- ADR-0001: Soroban storage TTL bump strategy
