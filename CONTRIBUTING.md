# Contributing

Thanks for your interest in contributing! This guide covers the workflow for
proposing changes, getting them reviewed, and promoting releases between
environments.

## Getting started

1. Fork the repository and create a topic branch off `main`.
2. Install dependencies and run the project locally (see the project README).
3. Make focused changes that address a single issue.
4. Open a pull request that references the issue it resolves.

## Pull request expectations

- Keep changes scoped to the linked issue. Avoid drive-by refactors.
- Match existing patterns, naming, and module structure.
- Include focused automated tests for new behavior, covering failure and
  boundary cases.
- Update the owning documentation (API, contract, operational, or contributor)
  when behavior or interfaces change.
- Do not weaken wallet authorization, chain/network validation, financial
  accounting invariants, or secret-handling requirements to make a change pass.

## Release promotion: deployment manifest review

Promoting contract and application versions between **testnet** and
**production** is gated on a reviewed, machine-validated deployment manifest.
A promotion must not proceed unless the manifest passes validation.

### Manifest requirements

Each promotion PR must include a deployment manifest that is validated for:

- **Network** — the manifest's target network must match the environment being
  promoted to (e.g. `testnet` → `production`). Mismatched networks are rejected.
- **Contract ID** — the contract ID must match the deployed contract for the
  source environment. Unknown or mismatched contract IDs are rejected.
- **Artifact digest** — the artifact digest must match the built artifact being
  promoted. A digest mismatch indicates the artifact changed after review and
  is rejected.
- **Schema compatibility** — the manifest schema version must be compatible with
  the validator. Incompatible or unknown schema versions are rejected.

Any validation failure blocks promotion and surfaces a clear error identifying
which field failed and why. Fix the manifest and re-request review rather than
bypassing validation.

### Approval responsibilities

- **Author** — prepares the manifest, ensures it reflects the exact artifact
  being promoted, and attaches validation output to the PR.
- **Reviewer** — confirms the manifest matches the intended network, contract,
  and artifact digest, and that schema compatibility passed. Reviewers are
  accountable for approving the promotion.
- **Release owner** — performs the promotion only after the manifest has been
  reviewed and validated, and records the approval in the release notes.

Promotions without a reviewed, validated manifest should be closed and returned
to the author.
