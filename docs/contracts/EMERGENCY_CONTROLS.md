# Emergency Controls — Protocol-Level Circuit Breaker

This document describes the FlowFi emergency stop mechanism: who can activate
it, how recovery is authorized, which operations are blocked and which remain
open, and the events emitted at each transition.

## Overview

FlowFi's circuit breaker provides a narrowly-scoped emergency stop that halts
all **new deposits** (token-in operations) while guaranteeing that **existing
user funds can always be withdrawn**. No pause state can trap capital that has
already been deposited.

The breaker is controlled via two entrypoints:

| Entrypoint | Purpose |
|---|---|
| `set_protocol_pause(caller, paused: bool)` | Trip (`true`) or clear (`false`) the breaker |
| `set_emergency_guardian(admin, guardian: Option<Address>)` | Delegate (or revoke) the pause-only guardian role |

---

## Role Matrix

| Role | Who grants it | Can pause | Can unpause | Notes |
|---|---|---|---|---|
| **Admin** | `initialize` / `transfer_admin` | ✅ | ✅ | Full admin capabilities |
| **Emergency guardian** | `set_emergency_guardian` (admin-only) | ✅ | ❌ | Narrowly scoped: pause only |
| Any other address | — | ❌ | ❌ | Rejected with `NotGuardian` or `NotAdmin` |

### Why is the guardian not allowed to unpause?

A guardian that could also unpause could silently reinstate deposits during the
very incident that triggered the pause. The asymmetric design means a
compromised or malfunctioning guardian key can only make the protocol *more*
restrictive, never less.

---

## What the Circuit Breaker Blocks and Allows

### Token-in entrypoints — blocked while paused

These entrypoints revert with `StreamError::ProtocolPaused` when the breaker is
engaged:

| Entrypoint | Paused behaviour |
|---|---|
| `create_stream` | ❌ `ProtocolPaused` |
| `create_step_vesting_stream` | ❌ `ProtocolPaused` |
| `create_hybrid_cliff_stream` | ❌ `ProtocolPaused` |
| `create_conditional_stream` | ❌ `ProtocolPaused` |
| `top_up_stream` | ❌ `ProtocolPaused` |
| `batch_create_streams` | ❌ `ProtocolPaused` |

### Token-out entrypoints — always open

These entrypoints succeed regardless of pause state:

| Entrypoint | Paused behaviour |
|---|---|
| `withdraw` | ✅ Always succeeds |
| `batch_withdraw` | ✅ Always succeeds |
| `cancel_stream` | ✅ Always succeeds — senders can always reclaim principal |

### Read-only views — unaffected

`get_stream`, `get_claimable_amount`, `is_protocol_paused`, `get_fee_config`,
and all other read-only queries are never affected by a pause.

---

## Events

Each state transition emits an on-chain event that indexers and monitoring
systems can observe:

### `ProtocolPauseStatusEvent`

Emitted by `set_protocol_pause` on every transition (both pause and unpause).

| Field | Type | Description |
|---|---|---|
| `caller` | `Address` | The address that called `set_protocol_pause` |
| `paused` | `bool` | `true` = paused, `false` = unpaused |
| `timestamp` | `u64` | Ledger timestamp of the transition |

Topics: `("protocol_pause_status",)`

### `EmergencyGuardianUpdatedEvent`

Emitted when the admin sets or clears the guardian via `set_emergency_guardian`.

| Field | Type | Description |
|---|---|---|
| `admin` | `Address` | Admin address that made the change |
| `guardian` | `Option<Address>` | New guardian address, or `None` if revoked |

Topics: `("emergency_guardian_updated",)`

---

## Recovery Procedure

```
1. INCIDENT DETECTED
       │
       ▼
2. Trip the breaker
   set_protocol_pause(admin_or_guardian, true)
   → Emits ProtocolPauseStatusEvent { paused: true }
       │
       ▼
3. Investigate & remediate
   • All existing streams can still be withdrawn / cancelled
   • No new deposits enter the protocol
       │
       ▼
4. Restore — ADMIN ONLY
   set_protocol_pause(admin, false)
   → Emits ProtocolPauseStatusEvent { paused: false }
       │
       ▼
5. Normal operation resumes immediately
```

A pause takes effect on the **same ledger** it is submitted and is visible to
`is_protocol_paused()` immediately after the transaction lands.

---

## Managing the Guardian

```bash
# Assign a guardian address
stellar contract invoke --id $CONTRACT_ID \
  --source $ADMIN_SECRET --network testnet \
  -- set_emergency_guardian \
  --admin $ADMIN_ADDRESS \
  --guardian $GUARDIAN_ADDRESS

# Revoke the guardian (admin becomes the sole pause authority)
stellar contract invoke --id $CONTRACT_ID \
  --source $ADMIN_SECRET --network testnet \
  -- set_emergency_guardian \
  --admin $ADMIN_ADDRESS \
  --guardian null
```

Removal takes effect immediately. A formerly-valid guardian key cannot pause the
protocol after it has been revoked.

---

## Security Properties

- **Funds are never trapped.** The design guarantees that no pause can prevent
  recipients from withdrawing vested funds or senders from reclaiming
  unstreamed principal.
- **Guardian cannot escalate privileges.** The guardian role is limited to
  `set_protocol_pause(true)`. It has no access to fee configuration, stream
  records, treasury, or admin transfers.
- **Pause authority is revocable.** The admin can remove or rotate the guardian
  at any time via `set_emergency_guardian`.
- **Single-ledger latency.** Both pausing and unpausing take effect immediately
  upon transaction confirmation — there is no timelock or delay.
- **No re-entrancy risk.** The circuit-breaker guard (`require_not_protocol_paused`)
  reads the config before any token transfers occur (CEI order preserved).

---

## Test Coverage

The following tests in `contracts/stream_contract/src/test.rs` cover the
emergency controls (Issue #38):

| Test | Covers |
|---|---|
| `guardian_can_pause_but_not_unpause` | Role asymmetry |
| `admin_can_pause_and_unpause` | Admin full authority |
| `without_guardian_only_admin_can_pause` | No guardian → only admin |
| `paused_protocol_blocks_create_stream` | Token-in blocked |
| `paused_protocol_allows_withdraw` | Token-out always open |
| `paused_protocol_allows_cancel_stream` | Token-out always open |
| `recovery_unpause_restores_create_stream` | Recovery path |
| `removed_guardian_can_no_longer_pause` | Guardian revocation |

Existing tests also cover individual entrypoints at the protocol level:
`test_guardian_can_pause_protocol`, `test_paused_protocol_blocks_create_stream`,
`test_paused_protocol_still_allows_withdraw`, etc.

---

## Related

- Contract implementation: `contracts/stream_contract/src/lib.rs`
  (`set_protocol_pause`, `set_emergency_guardian`, `require_not_protocol_paused`)
- Data types: `contracts/stream_contract/src/types.rs` (`ProtocolConfig`)
- Error variants: `contracts/stream_contract/src/errors.rs`
  (`StreamError::ProtocolPaused`, `StreamError::NotGuardian`, `StreamError::NotAdmin`)
- Events: `contracts/stream_contract/src/events.rs`
  (`ProtocolPauseStatusEvent`, `EmergencyGuardianUpdatedEvent`)
- Docs-site page: `docs-site/docs/contracts/emergency-pause.md`
- STRIDE threat model: `docs/security/STRIDE_THREAT_MODEL.md`
