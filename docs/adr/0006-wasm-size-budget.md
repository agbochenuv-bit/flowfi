# ADR 0006: WASM Size Budget for Stream Contract

- Status: Accepted
- Date: 2026-10-17
- Deciders: FlowFi core (contracts + CI)
- Related: `.github/workflows/ci.yml` (`Check WASM size budget` step),
  `docs/contracts/WASM_SIZE_BUDGET.md`, `contracts/stream_contract/`

## Context

Soroban smart contracts are deployed as WebAssembly binaries. Contract size
affects two areas directly:

1. **On-chain upload cost**: Stellar charges network fees proportional to the
   raw byte size of the uploaded WASM. A larger binary costs more to deploy and
   upgrade.
2. **Simulation and execution latency**: The Soroban host parses the WASM on
   every invocation preflight. A bloated binary widens the simulation window and
   increases RPC round-trip times for end users.

Without a CI gate, it is easy for size to grow silently: an innocent-looking
dependency addition or a missing `#[cfg(test)]` annotation can add tens of
kilobytes to the optimized binary without any reviewer noticing.

The FlowFi contract is purpose-built and should stay small. At the time of this
decision the optimized `stream_contract.wasm` is approximately 100–120 KB
before headroom is factored in.

## Decision

Enforce a hard **200 KB (200,000 byte)** limit on the optimized WASM in CI.

The `Check WASM size budget` step in `.github/workflows/ci.yml`:

- Runs after `stellar contract build --optimize`.
- Iterates over every `*.optimized.wasm` in the release output directory.
- Fails the build (`exit 1`) if any artifact exceeds `WASM_SIZE_LIMIT=200000`.
- Prints the measured size on every run so engineers can track trends over time.

The limit applies to the _optimized_ binary only. Unoptimized debug builds are
not gated because they are not deployed.

### Why 200 KB?

| Consideration | Value |
|---|---|
| Current baseline (optimized, at decision time) | ~100–120 KB |
| Comfortable headroom for new features | ~80–100 KB |
| Chosen limit | 200 KB |

200 KB was selected to give the current baseline roughly 60–80% room to grow
before the gate triggers. This is intentionally generous so that the limit acts
as a **regression detector**, not a day-to-day development obstacle. If the
project's feature scope grows substantially, the limit can be raised with an
explicit, reviewed PR (see Consequences below).

## Consequences

Positive:

- Size regressions are caught at merge time rather than at deployment time.
- Every CI run logs the exact byte count, giving a free trend-tracking record
  in the CI history.
- The gate is self-documenting: the `WASM_SIZE_LIMIT` variable in the CI YAML
  is the single source of truth and is visible in every build log.
- Forces contributors to investigate and justify size increases rather than
  accepting silent growth.

Negative / residual:

- Any feature that genuinely requires more than 200 KB must go through a
  deliberate limit-raise PR. This is a small process overhead but is
  intentional.
- The optimized binary size can vary slightly across Stellar CLI and
  `wasm-opt` versions. The limit must be set conservatively enough to avoid
  flaky failures from toolchain updates. The 80+ KB headroom provides this
  buffer.

## Alternatives considered

| Alternative | Why rejected |
|---|---|
| No size gate | Silent regressions; engineers only notice at deploy time |
| Warning-only (log size but do not fail) | Easy to ignore; defeats the purpose of the gate |
| 100 KB limit (tight) | Too close to the baseline; would trigger on minor additions and become a nuisance |
| 500 KB limit (very loose) | Provides no meaningful regression detection given the current baseline |
| Size gate via a separate script in `Makefile` | Not enforced on PRs unless CI runs it; GitHub Actions step is more reliable |

## Measurement procedure

See [docs/contracts/WASM_SIZE_BUDGET.md](../contracts/WASM_SIZE_BUDGET.md) for
step-by-step instructions on measuring locally, inspecting bloat by crate, and
the procedure for raising the limit if genuinely warranted.

## Revision history

| Date | Old limit | New limit | Reason |
|---|---|---|---|
| 2026-10-17 | — | 200 KB | Initial budget established |
