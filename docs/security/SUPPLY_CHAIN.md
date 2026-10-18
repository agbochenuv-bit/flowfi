# Software Supply Chain

## SBOMs and Release Artifacts

Every contract release must publish a machine-readable CycloneDX JSON SBOM alongside the optimized WASM and deployment metadata. The SBOM must cover both npm workspaces and the contract dependency graph in `contracts/Cargo.lock`, including transitive build inputs. Generate from committed manifests/lockfiles, identify the project and release version, and attach the SBOM to both the workflow run and GitHub release. Do not include credentials, environment values, or build-host paths. Retain the SBOM for the same period as the corresponding release artifacts. A release must not be considered complete if the SBOM is missing.

## Vulnerability Triage

CI runs npm audit for production dependencies and `cargo audit` for Rust dependencies. Security findings are triaged by the owning team using the affected package, reachable code path, exploit prerequisites, and available fix/mitigation.

| Severity | Acknowledge | Target remediation |
|---|---:|---:|
| Critical, actively exploited, or credential/asset compromise | 1 business day | Mitigate immediately; patch or remove within 7 calendar days |
| High | 3 business days | Patch or document a time-bounded exception within 14 calendar days |
| Medium | 10 business days | Patch within 30 calendar days |
| Low | Next dependency maintenance cycle | Patch within 90 calendar days |

An exception must name an owner, affected versions, exploitability rationale, compensating controls, and expiry date. Reassess exceptions at expiry and after a new advisory or reachable-code change. Prefer an upstream fixed version; do not suppress an advisory solely to make CI green. Re-run dependency scans and regenerate SBOMs after remediation.

## Workflow Controls

- Workflows default to read-only repository permissions; grant additional permissions only to the job that needs them.
- Pin third-party actions to a full commit SHA and include a release tag comment for maintainability.
- Do not use `pull_request_target` to check out or execute contributor code.
- Treat PR titles, branches, bodies, labels, and changed files as untrusted data. Pass values through environment variables and validate before shell use; never interpolate them into shell source.
- Never expose deployment or infrastructure secrets to a fork PR. PR validation must remain useful with secrets unavailable.
