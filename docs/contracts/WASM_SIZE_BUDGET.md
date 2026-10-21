# WASM Size Budget

FlowFi enforces a hard size limit on the compiled, optimized Soroban contract
binary. This document explains the budget, how it is enforced in CI, how to
measure it locally, and what to do when the budget is breached.

## Budget

| Artifact | Limit |
|---|---|
| `stream_contract.optimized.wasm` | **200 KB (200,000 bytes)** |

The limit applies to the _optimized_ WASM produced by `stellar contract build
--optimize`. The unoptimized debug binary is not gated.

## Rationale

See [ADR 0006](../adr/0006-wasm-size-budget.md) for the full decision record.
In short:

- Soroban charges upload fees proportional to contract size. A smaller binary
  costs less to deploy and upgrade.
- Smaller contracts parse faster on-chain, reducing simulation latency.
- A CI gate prevents size regressions from being merged silently.

The 200 KB ceiling was chosen to give the current feature set (~100–120 KB
baseline) a comfortable 60–80 KB headroom for future additions before the limit
is ever likely to be hit.

## CI Enforcement

The `Check WASM size budget` step in `.github/workflows/ci.yml` runs after
`stellar contract build --optimize` and fails the build if any
`*.optimized.wasm` file exceeds 200,000 bytes:

```yaml
- name: Check WASM size budget
  run: |
    set -euo pipefail
    RELEASE_DIR="contracts/target/wasm32-unknown-unknown/release"
    WASM_SIZE_LIMIT=200000  # 200 KB budget for optimized WASM

    for wasm in "$RELEASE_DIR"/*.optimized.wasm; do
      if [ -f "$wasm" ]; then
        size=$(stat -c%s "$wasm")
        filename=$(basename "$wasm")
        echo "Optimized WASM size: $filename = $size bytes"
        if [ "$size" -gt "$WASM_SIZE_LIMIT" ]; then
          echo "Error: $filename exceeds size budget of $WASM_SIZE_LIMIT bytes"
          exit 1
        fi
      fi
    done
```

## Measuring Locally

### Quick check (after build)

```bash
# From the repo root
cd contracts
stellar contract build --optimize

# The optimized WASM may be in either directory depending on the Stellar CLI version
WASM=$(find target -name "stream_contract.optimized.wasm" 2>/dev/null | head -1)
if [ -n "$WASM" ]; then
  stat -c%s "$WASM"
else
  echo "WASM not found — run stellar contract build --optimize first"
fi
```

### Without the Stellar CLI optimizer

If you want a quick size estimate before optimizing:

```bash
cd contracts
cargo build --target wasm32-unknown-unknown --release
stat -c%s target/wasm32-unknown-unknown/release/stream_contract.wasm
```

Note: the unoptimized binary is typically 2–4× larger than the optimized one.
The CI limit applies to the optimized binary only.

### Using `wasm-opt` directly

The Stellar CLI optimizer calls `wasm-opt` under the hood. You can invoke it
manually to test optimization levels:

```bash
# Install binaryen if not present
apt-get install -y binaryen   # Debian/Ubuntu
# or: cargo install wasm-opt

wasm-opt -Os -o stream_contract.optimized.wasm \
  target/wasm32-unknown-unknown/release/stream_contract.wasm

stat -c%s stream_contract.optimized.wasm
```

## What Counts Toward the Budget

The optimized WASM contains:

- Compiled contract logic (all public entrypoints + private helpers)
- Soroban host-function shims
- Metadata sections (ABI, contract spec)
- Any statically linked Rust standard-library code not eliminated by LTO

It does **not** include:

- Test code (cfg-gated with `#[cfg(test)]`)
- Dev-dependencies
- Build scripts

## Keeping the Binary Small

| Practice | Impact |
|---|---|
| Use `#[cfg(test)]` on all test-only code | Eliminates test helpers from production WASM |
| Avoid pulling in large dependencies | Each new crate may add tens of KB |
| Prefer Soroban host-function operations over pure-Rust equivalents | Host fns are imported (0 size), not compiled in |
| Use `cargo bloat` to identify large code sections | Pinpoints bloat before it merges |
| Enable LTO in `Cargo.toml` (`lto = true`) | Already enabled; do not remove |

### Inspecting what is large

```bash
# Install cargo-bloat
cargo install cargo-bloat

cd contracts
cargo bloat --target wasm32-unknown-unknown --release --crates
```

This shows which crates contribute most to the binary size.

## Raising the Budget

If a deliberate new feature genuinely requires more than 200 KB:

1. Measure the size of the new optimized binary.
2. Open a PR that:
   - Updates `WASM_SIZE_LIMIT` in `.github/workflows/ci.yml`.
   - Updates the table at the top of this file.
   - Adds an entry to [ADR 0006](../adr/0006-wasm-size-budget.md) under
     **Revision history** explaining why the limit was raised.
3. Get at least one reviewer to sign off that the size increase is justified.

Do not raise the limit to "just make CI pass" without investigating the cause
of the regression first.

## Troubleshooting

### CI passes locally but fails in CI

The Stellar CLI version in CI may differ from your local install. Pin the CLI
version used in `ci.yml` and match it locally:

```bash
stellar --version
# match the version shown in .github/workflows/ci.yml
```

### `stat -c%s` not available (macOS)

Replace with `stat -f%z`:

```bash
stat -f%z stream_contract.optimized.wasm
```

### Optimized WASM not found after build

Recent Stellar CLI versions write to `target/wasm32v1-none/release/` instead of
`target/wasm32-unknown-unknown/release/`. The CI script handles both locations.
Locally, use:

```bash
find contracts/target -name "stream_contract.optimized.wasm"
```
