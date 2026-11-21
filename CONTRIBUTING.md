# Contributing

Thanks for your interest in contributing. This document covers the basics.

## Getting started

1. Fork the repository and create a topic branch from `main`.
2. Make focused changes that address a single issue.
3. Open a pull request describing the change and linking the issue.

## Code style

- Match the existing patterns, naming, and module structure of the files you touch.
- Keep changes surgical; avoid unrelated refactors or formatting churn.
- Do not weaken wallet authorization, chain/network validation, financial accounting invariants, or secret-handling requirements.

## Tests

- Add focused automated coverage for changed behavior, including failure and boundary cases.
- Do not commit secrets, tokens, or credentials.

## Verifier-backed conditional release policies

Streams may make accrual or release conditional on a configured verifier result. When working on this capability, keep the following explicit in code, tests, and docs:

- **Verifier identity**: record which verifier (address/identifier) is trusted for a stream. Only results from the configured verifier are honored; results from any other source must be rejected.
- **Trust assumptions**: the protocol trusts the configured verifier to report results honestly and in a timely manner. It does not independently validate the underlying off-chain condition. Document this assumption wherever the policy is configured.
- **Timeout**: define a bounded timeout for verifier responses. A result arriving after the timeout must not release funds.
- **Failure mode**: define what happens when the verifier is unavailable, times out, or returns a malformed response. The default must be fail-closed — no release on an unverifiable result.
- **Replay/nonce semantics**: results must be bound to a stream and a nonce (or equivalent) so a previously accepted result cannot be replayed to trigger additional release. Reject reused or out-of-order results.

When adding or changing this behavior, include tests for malformed verifier responses, an unavailable verifier, the timeout boundary, and replay attempts.
