# FlowFi Contracts

This directory contains the Soroban smart contracts for FlowFi.

## Workspace Layout

This directory is a [Cargo workspace](https://doc.rust-lang.org/book/ch14-03-cargo-workspaces.html)
root. The workspace manifest is `contracts/Cargo.toml`, and each contract lives in its
own member crate under this directory.

```
contracts/
├── Cargo.toml              # Workspace manifest — run `cargo build` / `cargo test` here
├── Cargo.lock
└── stream_contract/         # Member crate (the core streaming contract)
    ├── Cargo.toml
    └── src/
```

**Always run `cargo build` / `cargo test` from the workspace root** (`contracts/`), never
from inside a member crate. The workspace `[profile.release]` section in `Cargo.toml`
configures WASM-specific optimisations for all members.

## Adding a New Contract Crate

1. Create a new crate directory under `contracts/`, e.g. `contracts/my_contract/`.
2. Add a `[package]` section in its `Cargo.toml` and reference `soroban-sdk` via
   `workspace = true`:
   ```toml
   [dependencies]
   soroban-sdk = { workspace = true }
   ```
3. Register the crate in `contracts/Cargo.toml` under `[workspace] members`:
   ```toml
   members = ["stream_contract", "my_contract"]
   ```
4. Run `cargo build` from `contracts/` to verify the workspace compiles.

For contract-specific documentation see the crate's own `README.md`.

## Crate docs

- **[`stream_contract/`](./stream_contract/)** — Core streaming contract (create, top-up,
  withdraw, cancel, pause/resume). See [`stream_contract/README.md`](./stream_contract/README.md)
  for its full API reference.

## Layout

- `stream_contract/`: Contains the core streaming logic, including stream creation, funding, claiming, and cancellation.

## Stream State Machine

Payment streams have two independent boolean fields (`is_active` and `paused`) plus a
`status` enum. The following invariants govern state transitions:

| Current Status | Allowed Transitions | Notes |
|----------------|---------------------|-------|
| `Active` | → `Paused`, → `Cancelled`, → `Completed` | `pause_stream` sets `paused=true`, `cancel_stream` sets `is_active=false` |
| `Paused` | → `Active` (resume), → `Cancelled` | `resume_stream` clears `paused`; `cancel_stream` sets `is_active=false` |
| `Cancelled` | **No transitions allowed** | **Invariant: a cancelled stream must never be resumable.** Once `status` is `Cancelled`, the stream is permanently inactive regardless of `paused` or `is_active` values. |
| `Completed` | **No transitions allowed** | Stream fully drained; `is_active=false` |

### Critical Invariant: Cancelled Streams Are Permanent

The `is_active` and `paused` fields are independently-settable, but once a stream's
`status` is set to `Cancelled` (via `cancel_stream`), it **cannot** be resumed. This
invariant must be preserved across all contract changes to prevent state-invariant bugs.

**Why this matters:** If a cancelled stream could be resumed, it would allow token
redistribution after the sender has already received their refund, creating a
double-spend vulnerability.

**Enforcement:** The `cancel_stream` function sets both `is_active = false` and
`status = Cancelled`. The `resume_stream` function requires `paused = true` but
does not explicitly re-check `status`, so the invariant relies on the fact that
`cancel_stream` sets `is_active = false` and `validate_stream_active` is called
before `pause_stream`. See Testing #94 for test coverage of this invariant.

## Scheduled Activation & Expiry

Streams may declare a future activation time and an optional expiry time so that
accrual is bounded to a well-defined window. Both are expressed in **ledger
timestamps** — Unix seconds (`u64`), the same unit returned by
`env.ledger().timestamp()` and used by every other time field in the contract.
They are **not** ledger sequence numbers.

| Field | Type | Meaning |
|-------|------|---------|
| `start_time` | `u64` | First ledger timestamp at which the stream accrues. `0` means "active immediately" (backwards compatible). |
| `end_time` | `Option<u64>` | Optional last ledger timestamp at which the stream accrues. `None` means "no expiry" (backwards compatible). |

### Boundary Semantics

Accrual is computed over the half-open interval `[start_time, end_time)` clamped to
`[start_time, now]`:

- **Before start** (`now < start_time`): accrued amount is `0`. Claims succeed but
  transfer nothing; `pause_stream` / `cancel_stream` remain allowed.
- **Exact start** (`now == start_time`): accrual begins; accrued amount is `0` at
  this instant and grows thereafter.
- **Within window** (`start_time < now < end_time`): accrual is
  `rate * (now - start_time - paused_duration)`.
- **Exact end** (`now == end_time`): accrual stops at `end_time`; the full window
  amount is claimable. No further accrual occurs after this instant.
- **After end / late claim** (`now > end_time`): accrual is frozen at the window
  total. Late claims are permitted and pay out the remaining vested balance; the
  stream transitions to `Completed` once fully drained.

### Pause / Resume Interaction

Pausing only suspends accrual while the stream is inside its active window. Time
spent paused is excluded from the accrued total, so a stream paused before
`start_time` accrues nothing until it is resumed and `now >= start_time`. Resuming
a stream whose `end_time` has already passed does not restart accrual — the
window total remains the ceiling.

### Cancellation Interaction

`cancel_stream` refunds the sender the unvested portion of the funded amount,
computed against the same `[start_time, end_time)` window. Cancelling before
`start_time` refunds the full funded amount; cancelling after `end_time` refunds
only what was never claimed. The permanent-cancellation invariant above still
applies: a cancelled stream can never be resumed regardless of its window.

### Validation

`create_stream` rejects `end_time <= start_time` when `end_time` is `Some`, and
rejects `start_time` values that are already in the past relative to the current
ledger timestamp. Existing callers that omit the new fields keep the previous
immediate-start, no-expiry behaviour.

## Building & Testing

To build the contracts for testing and validation:

```bash
cargo build
cargo test
```

## Rust Toolchain

CI runs on the **stable** Rust toolchain (via `dtolnay/rust-toolchain@stable`)
with the `wasm32-unknown-unknown` target installed and the `rustfmt` / `clippy`
components. The workspace and member crates declare `rust-version = "1.81.0"` as
the minimum supported Rust version.

## WASM Target

To compile the contract to the `wasm32-unknown-unknown` target for Soroban deployment:

```bash
cargo build --target wasm32-unknown-unknown --release
stellar contract optimize --wasm target/wasm32-unknown-unknown/release/stream_contract.wasm
```

The optimized WASM file will be available at `target/wasm32-unknown-unknown/release/stream_contract.optimized.wasm`.
