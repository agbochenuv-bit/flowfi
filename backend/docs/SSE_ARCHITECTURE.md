# SSE Architecture

This document describes how the backend streams real-time events to clients over
Server-Sent Events (SSE), the shape of those events, and how the published
schemas are versioned for generated consumers.

## Overview

- Events are emitted by the backend and delivered over a single SSE connection.
- Each event has a stable `type` discriminator and a JSON `data` payload.
- Payload schemas are published as machine-readable JSON Schema artifacts so
  downstream systems can validate payloads and plan compatible upgrades.

## Event envelope

Every SSE message uses the standard `event:` / `data:` framing:

```
event: stream.event
data: {"type":"stream.event","version":"1.0.0","data":{...}}
```

## Versioned schemas

Schemas live under `backend/schemas/` and are versioned **independently** from
package releases. A schema version is bumped only when the event contract
changes, not on every package publish.

| Artifact | Purpose |
| --- | --- |
| `schemas/stream-event.v1.json` | JSON Schema (draft 2020-12) for the `stream.event` payload |
| `schemas/stream-event.v1.example.json` | Example payload used by the consumer example and tests |

### Backward-compatibility rules

Within a major version (`v1`):

- **Additive-only changes are allowed.** New optional properties may be added;
  existing properties keep their name, type, and meaning.
- **Required fields may not be added** within a major version.
- **Existing fields may not be removed or retyped** within a major version.
- **Breaking changes require a new major version** (e.g. `stream-event.v2.json`).
  Consumers pin to a major version and can migrate deliberately.

These rules are enforced by automated tests that validate the example payload
against the schema and assert the failure cases (invalid payloads, missing
required fields, version mismatch).

## Consumer example

Generated consumers validate incoming payloads against the published schema
before processing. A minimal example:

```ts
import Ajv from "ajv";
import schema from "../schemas/stream-event.v1.json";

const ajv = new Ajv({ strict: false });
const validate = ajv.compile(schema);

function handleEvent(raw: unknown) {
  if (!validate(raw)) {
    throw new Error(`invalid stream event: ${ajv.errorsText(validate.errors)}`);
  }
  // raw is now a validated stream.event payload
  return raw;
}
```

## Operational notes

- Schema artifacts are static files; publishing a new schema does not require a
  backend deploy.
- Consumers should tolerate unknown optional fields (forward compatibility) and
  reject payloads that fail validation.
- When introducing a new major version, keep the previous major schema
  available for at least one deprecation window.
