# Testnet E2E Smoke Scenario

This directory documents the deployed-testnet smoke scenario used to validate
stream creation and lifecycle calls against a real network. It is intentionally
kept small and is **not** the primary integration surface — deterministic local
fixtures (see below) are the default for automated coverage.

## Deployed testnet smoke scenario

The smoke scenario exercises the same stream lifecycle as the local fixtures so
that local and testnet behavior stay in parity:

1. Create a stream (deposit + start time).
2. Read the stream back and assert the stored parameters.
3. Withdraw a partial amount and assert balances.
4. Cancel the stream and assert the remaining balance is refunded.

Run it only when a funded testnet account and a deployed contract are available.
It is expected to be flaky by nature (network availability, faucet limits) and
must not gate CI.

## Deterministic local Soroban integration fixtures

Local fixtures provide the same stream creation and lifecycle coverage without
depending on public testnet availability. They are the source of truth for
integration tests; the testnet smoke scenario is a periodic parity check.

### Startup

1. Pin the contract artifact: the fixture loads the pre-built Soroban contract
   WASM from the pinned artifact path/version recorded alongside the fixtures.
   Do not rebuild from a moving branch — the artifact is versioned so results are
   reproducible.
2. Start a local Soroban/RPC environment (e.g. a local quickstart node) and
   deploy the pinned artifact.
3. Seed deterministic accounts with fixed keys and fixed starting balances.

### State reset between cases

Each test case runs against a freshly reset ledger state:

- The fixture resets ledger state (or redeploys the pinned artifact) before every
  case so cases are independent and order-insensitive.
- Accounts, stream IDs, and timestamps are deterministic, so assertions are
  stable across runs and machines.

### Parity with the testnet smoke scenario

The local fixture suite mirrors the smoke scenario steps above (create, read,
partial withdraw, cancel/refund) and additionally covers the failure and
boundary cases that are impractical to exercise on testnet:

- Creating a stream with an invalid/zero deposit or invalid time range fails.
- Withdrawing more than the vested amount fails.
- Withdrawing after cancellation fails.
- Cancelling an already-cancelled stream fails.
- Boundary: withdrawing exactly the fully vested amount succeeds and leaves a
  zero claimable balance.

When the testnet smoke scenario changes, update the local fixtures in the same
change so parity is preserved.
