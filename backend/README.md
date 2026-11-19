# Backend

This directory contains the API server, contract definitions, and operational tooling for the platform.

## API versioning and deprecation

API responses are versioned. Generated frontend and partner clients are built against
versioned response fixtures so that breaking changes are caught before they ship.

### Compatibility fixtures

Versioned response fixtures live under `backend/tests/fixtures/api-compat/` and are
organized by API version (for example `v1/` for the current version and `v1-deprecated/`
for versions inside a documented deprecation window). Each fixture captures a
representative response for the endpoints consumed by generated clients.

### Compatibility tests

The compatibility suite (`backend/tests/api-compat.test.*`) runs the generated clients
against these fixtures and asserts that:

- Current-version responses remain consumable by the generated frontend and partner clients.
- Deprecated fields remain present for the full documented deprecation window, and are
  only removed once the window has closed.
- Any breaking response change (removed/renamed field, changed type, changed nullability)
  fails the suite unless a corresponding migration note is recorded in
  `backend/docs/DEPRECATION_POLICY.md`.

When you intentionally change a response shape:

1. Add or update the versioned fixture for the affected version.
2. Record the change and its migration path in `backend/docs/DEPRECATION_POLICY.md`.
3. Update the generated clients if the change is not backward compatible.

Running the suite without a migration note for a breaking change is expected to fail;
that failure is the signal to document the migration before merging.
