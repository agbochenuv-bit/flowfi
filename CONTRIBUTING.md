# Contributing

Thanks for helping improve this project. This guide covers local setup, the
pull-request workflow, and the environment policy that CI enforces on every PR.

## Getting started

1. Fork the repository and create a topic branch from `main`.
2. Install dependencies for the package you are changing (see each package's
   `README.md`).
3. Make focused changes with tests, then open a pull request.

## Pull-request workflow

- Keep each PR scoped to a single capability or fix.
- Include automated coverage for new behavior, including failure and boundary
  cases.
- Update the owning documentation (API, contract, operational, or contributor)
  alongside code changes.
- Keep existing interfaces compatible unless the change explicitly versions
  them.

## Environment policy validation

Every pull request runs an environment policy check before preview or
production deployment workflows are allowed to run or publish. The check
validates the workflow configuration against the approved policy for:

- **Networks** — only approved chain/network identifiers may be referenced by
  preview and deployment workflows.
- **Domains** — preview and deployment hosts must match the approved domain
  allowlist.
- **Secrets** — workflows may only reference approved secret names, and secret
  values must never be printed, echoed, or committed.

### Accepted vs. rejected configurations

- **Accepted** fixtures use approved networks, domains, and secret names, and
  reference secrets only through the secret store (never inline values).
- **Rejected** fixtures reference an unapproved network, an off-allowlist
domain, or an unapproved/inline secret. The check fails the PR with an
  actionable message that names the offending workflow, the policy rule that
  was violated, and the offending key — but never the secret value itself.

### Reporting failures safely

When the policy check fails, it reports:

- the workflow file and job/step that violated the policy,
- the rule category (network, domain, or secret) and the expected allowlist
  entry,
- the offending configuration key.

It must not echo secret values, resolved environment contents, or full
credential strings. If you believe a failure is a false positive, update the
approved policy in the same PR with justification rather than weakening the
check.

### Running the check locally

Run the environment policy validation for your changed workflows before
pushing. Fix any reported violations; do not bypass or disable the check to
make a PR pass.

## Secret handling

- Never commit secrets, tokens, or credentials.
- Reference secrets only by name through the secret manager.
- Do not weaken wallet authorization, chain/network validation, financial
  accounting invariants, or secret-handling requirements to make a change
  pass.

## Code of conduct

Be respectful and constructive in reviews and discussions.
