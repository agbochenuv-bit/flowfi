# Backend

This directory contains the backend services for the project, including the API server, indexer, and supporting infrastructure.

## API Versioning & Migration Guides

The API is versioned. Each supported version has a dedicated migration guide that documents behavior differences, timelines, deprecation dates, a compatibility checklist, and tested request/response examples. Each guide links to the OpenAPI schema for that version.

| Version | Status | OpenAPI schema | Migration guide |
| --- | --- | --- | --- |
| v1 | Deprecated (sunset 2025-12-31) | [`openapi/v1.yaml`](./openapi/v1.yaml) | [`docs/migrations/v1.md`](./docs/migrations/v1.md) |
| v2 | Current | [`openapi/v2.yaml`](./openapi/v2.yaml) | [`docs/migrations/v2.md`](./docs/migrations/v2.md) |

When introducing a new API version, add a row above and publish a matching guide under `docs/migrations/` that includes:

- A link to the version's OpenAPI schema.
- Explicit behavior differences and timelines versus the previous version.
- A compatibility checklist integrators can follow before switching.
- Deprecation dates for the version being superseded.
- Tested request/response examples covering the changed behavior, including failure and boundary cases.

See [`docs/migrations/`](./docs/migrations/) for the full set of guides.
