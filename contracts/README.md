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

## Protocol Governance Features

### Timelocked Policy Changes (#217)

Protocol-wide configuration changes (fee config, circuit breaker, emergency guardian, admin transfer) can be proposed through a timelocked lifecycle:

1. **Propose** — `propose_policy_change` stores a `PolicyOperation` with an `execute_after` timestamp set `timelock_delay_seconds` in the future.
2. **Wait** — the delay must elapse before execution; the proposal stays `Pending` and cancellable.
3. **Execute** — `execute_policy_change` replays the stored operation after the delay elapses (callable by anyone).
4. **Cancel** — `cancel_policy_change` revokes a pending proposal (callable by proposer or admin).

Guardian-restricted operations (pause, guardian) may be proposed by the emergency guardian; admin-only operations (fee config, admin transfer) require the admin.

### Contract Upgrade & State Migration (#218, #219)

The contract supports in-place executable upgrades and state schema migrations:

- **`upgrade(new_wasm_hash)`** — replaces the contract's WASM in place, preserving address, storage, and active streams. Admin-only. Records the old and new hashes in `DataKey::ContractWasmHash` and emits `ContractUpgradedEvent`.
- **`migrate(target_version)`** — advances the on-chain state schema version. Forward-only, idempotent, admin-only. Rewrites the protocol config into the current shape; stream records heal lazily on next read via `load_stream` / `load_config`.

Version compatibility matrix:

| On-chain version | Layout | Readable by contract v2 |
|------------------|--------|-------------------------|
| `0` (unversioned) | 3-field `ProtocolConfig`, 12-field `Stream` | Yes (legacy decode) |
| `1` (versioned pre-breaker) | 3-field `ProtocolConfig`, no `schedule` on `Stream` | Yes (legacy decode) |
| `2` (current) | 7-field `ProtocolConfig`, 17-field `Stream` with `schedule` | Yes (native) |

Migration is lazy: Soroban exposes no persistent-storage enumeration, so records are upgraded on first touch rather than in bulk.

### Versioned Storage Decoding (#219)

Each `Stream` record carries a `stream_schema_version` field stamped at write time. Legacy records (fewer fields) are detected by field count and decoded into `LegacyStream` / `LegacyProtocolConfig`, then widened in memory with safe defaults (`dispute_requested_at: None`, `arbiter: None`, `dispute_status: None`, `is_allowance_based: false`, `stream_schema_version: CURRENT_DATA_VERSION`).

### Dispute Holds with Timeout (#220)

A stream with an `arbiter` configured cannot be unilaterally cancelled. Instead:

1. The sender calls `request_dispute`, setting `dispute_status = Requested` and recording `dispute_requested_at`.
2. The arbiter calls `resolve_dispute` with `approved = true` (cancels and distributes funds) or `approved = false` (rejects, stream stays active).
3. If `ProtocolConfig::dispute_timeout_seconds` is set and the deadline passes, the admin may call `resolve_dispute_timeout` to force-reject the dispute (`approved = false`), keeping the stream active.

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

## Stream Receipts (Non-Transferable Metadata)

Every stream exposes a **read-only receipt** for wallets and indexers. A receipt is
purely descriptive metadata: it is derived from the stream's stored state and is
**not** a bearer instrument. Holding, displaying, or indexing a receipt grants **no**
privileged action — all authorization still flows through the stream's `sender` /
`recipient` checks in the contract entry points.

### Receipt fields

| Field | Type | Description |
|-------|------|-------------|
| `stream_id` | `u64` | Identifier of the stream the receipt describes |
| `sender` | `Address` | Stream funder (authorization subject for cancel/pause) |
| `recipient` | `Address` | Stream beneficiary (authorization subject for withdraw) |
| `token` | `Address` | Token contract being streamed |
| `deposited` | `i128` | Total amount deposited into the stream |
| `withdrawn` | `i128` | Total amount already withdrawn |
| `status` | `StreamStatus` | Lifecycle status at read time |
| `paused` | `bool` | Whether the stream is currently paused |
| `is_active` | `bool` | Whether the stream is currently active |

### Lifecycle mapping

The receipt's `status` / `paused` / `is_active` fields mirror the stream state machine
above and are recomputed on every read, so the metadata stays stable and consistent
through transitions:

| Lifecycle | `status` | `paused` | `is_active` |
|-----------|----------|----------|-------------|
| Created / Active | `Active` | `false` | `true` |
| Paused | `Paused` | `true` | `true` |
| Resumed | `Active` | `false` | `true` |
| Completed | `Completed` | `false` | `false` |
| Cancelled | `Cancelled` | `false` | `false` |

### Non-transferability & authorization

- Receipts are **not** transferable: there is no mint, transfer, or approval entry point.
- Reading a receipt (`get_stream_receipt`) requires no authorization and confers none.
- Privileged actions remain gated by the stream's `sender` / `recipient` checks; a
  receipt holder who is neither cannot withdraw, pause, resume, or cancel.

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
