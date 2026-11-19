# Contributing

Thanks for helping improve this project. This guide covers local setup, the checks we expect before a pull request, and the operational game days we run to keep dependency outages boring.

## Getting started

1. Install dependencies with your package manager of choice.
2. Copy the example environment file and fill in local-only values. Never commit secrets.
3. Run the test suite before opening a pull request.

## Pull request expectations

- Keep changes focused; one capability per pull request.
- Add or update automated coverage for changed behavior, including failure and boundary cases.
- Update the owning API, contract, operational, or contributor documentation alongside code changes.
- Do not weaken wallet authorization, chain/network validation, financial accounting invariants, or secret-handling requirements.

## System context and trust boundaries

The versioned system context and trust-boundary map lives in [`backend/docs/SYSTEM_CONTEXT.md`](backend/docs/SYSTEM_CONTEXT.md). It is the single maintained view of the browser, wallet, API, worker, database, RPC, and external-provider boundaries, and links each boundary to its owning code paths and the data flows that cross it.

When a change moves, adds, or removes a trust boundary (a new external provider, a new worker, a new privileged code path), update `SYSTEM_CONTEXT.md` in the same pull request:

- Bump the document's `Version` and add a row to its changelog.
- Keep the boundary table's owning-code links pointing at real files.
- Keep the Mermaid diagram blocks intact so the validation check can parse them.

The referenced code paths and diagram markers are validated automatically (see the document's *Validation* section). Run the check locally before opening a pull request; a missing referenced path or a malformed diagram block fails the check.

## Dependency outage game days

Game days exercise operator response to dependency outages in an isolated environment. They are repeatable: run the same scenarios on a schedule and compare outcomes across runs.

### Environment

- Use a dedicated, isolated environment (separate database, cache, Soroban RPC endpoint, and webhook receiver). Never point a game day at production.
- Production execution stays behind explicit approval. Game days must not trigger production mutations, and no automation may promote a game-day run to production without a human approving it.
- Seed the environment with disposable data only.

### Scenarios

Run each scenario independently, then record the outcome before moving to the next:

1. **Database outage** — make the primary database unreachable.
2. **Cache outage** — make the cache unreachable or return errors.
3. **Soroban RPC outage** — point the app at an unreachable or failing RPC endpoint.
4. **Webhook provider outage** — make the webhook receiver fail or time out.

### What to verify

- **Detection**: the outage is surfaced (health checks, alerts, or logs) within the expected window.
- **Recovery**: once the dependency returns, the system recovers without manual data repair.
- **No unsafe mutation fallback**: during an outage the system fails closed. It must not silently fall back to an unsafe mutation path, skip validation, or write partial state. Requests that cannot be safely completed should be rejected, not approximated.
- **Approval gate**: no production execution occurs without explicit approval.

### Recording outcomes

For each scenario, record a structured entry so runs are comparable:

```
scenario: database | cache | soroban-rpc | webhook
started_at: <ISO-8601>
detected_at: <ISO-8601 or "not detected">
recovered_at: <ISO-8601 or "not recovered">
unsafe_mutation_fallback: none | <description>
production_execution: blocked | <approval reference>
notes: <free text>
```

A run is successful only when every scenario is detected, recovers, reports `unsafe_mutation_fallback: none`, and shows production execution blocked. File follow-ups for any scenario that fails and link them from the run record.

### Automated coverage

Where practical, encode the failure and boundary cases above as automated tests so regressions are caught before the next game day. Tests should assert fail-closed behavior rather than silent fallback.
