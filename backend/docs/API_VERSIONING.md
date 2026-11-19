# API Versioning Strategy

## Overview

FlowFi API uses **URL-based versioning** to ensure backward compatibility and allow for breaking changes without disrupting existing consumers.

## Versioning Scheme

### URL-Based Versioning

All API endpoints are prefixed with a version identifier:

```
/v1/streams
/v1/events/subscribe
/v1/events/stats
```

**Format:** `/v{version}/{resource}`

### Why URL-Based?

- ✅ **Explicit and discoverable** - Version is visible in the URL
- ✅ **Easy to test** - Simple to change version in browser/Postman
- ✅ **Cache-friendly** - Different versions can be cached separately
- ✅ **Clear migration path** - Easy to see which version you're using
- ✅ **No header dependencies** - Works with any HTTP client

## Supported Versions

| Version | Status | Introduced | Sunset Date |
|---------|--------|------------|-------------|
| `v1` | ✅ Current | 2024-02-21 | TBD |

### Version Lifecycle

1. **Current** - Actively maintained, receives new features and bug fixes
2. **Deprecated** - Still supported but will be sunset on a specific date
3. **Sunset** - No longer available, returns 410 Gone

## Adding New Endpoints

### Rules

1. **All new endpoints MUST be added under a version namespace**
   ```typescript
   // ✅ Correct
   router.post('/v1/streams', createStream);
   
   // ❌ Incorrect
   router.post('/streams', createStream);
   ```

2. **Breaking changes require a new version**
   - Changing request/response structure
   - Removing required fields
   - Changing field types
   - Removing endpoints

3. **Non-breaking changes can be added to existing version**
   - Adding optional fields
   - Adding new endpoints
   - Adding new query parameters
   - Adding new response fields

### Example: Adding a New Endpoint

```typescript
// backend/src/routes/v1/stream.routes.ts
router.get('/:streamId', getStream); // Add to v1
```

### Example: Breaking Change

If you need to change the response structure:

```typescript
// Create v2 routes
// backend/src/routes/v2/stream.routes.ts
router.get('/:streamId', getStreamV2); // New structure

// Update app.ts
import v2Routes from './routes/v2/index.js';
app.use('/v2', v2Routes);
```

## Deprecation Policy

### Deprecation Timeline

1. **Announcement** - Deprecated endpoints return warnings in response headers
2. **Deprecation Period** - Minimum 6 months before sunset
3. **Sunset** - Endpoint returns `410 Gone` with migration information

### Deprecation Headers

Deprecated endpoints include:

```
X-API-Deprecated: true
X-API-Sunset-Date: 2024-12-31
X-API-Migration-Path: /v1/streams
```

### Example Deprecated Response

```json
{
  "error": "Deprecated endpoint",
  "message": "This endpoint has been deprecated. Please use /v1/streams instead.",
  "deprecated": true,
  "migration": {
    "old": "/streams",
    "new": "/v1/streams"
  },
  "sunsetDate": "2024-12-31"
}
```

## Migration Guide

### For API Consumers

1. **Update base URL** to include version:
   ```javascript
   // Before
   const response = await fetch('http://api.flowfi.io/streams');
   
   // After
   const response = await fetch('http://api.flowfi.io/v1/streams');
   ```

2. **Check for deprecation headers**:
   ```javascript
   const isDeprecated = response.headers.get('X-API-Deprecated') === 'true';
   if (isDeprecated) {
     const sunsetDate = response.headers.get('X-API-Sunset-Date');
     console.warn(`Endpoint will be sunset on ${sunsetDate}`);
   }
   ```

3. **Monitor health endpoint** for supported versions:
   ```javascript
   const health = await fetch('http://api.flowfi.io/health');
   const { apiVersions } = await health.json();
   console.log('Supported versions:', apiVersions.supported);
   ```

## Version Detection

### Health Endpoint

The `/health` endpoint includes version information:

```json
{
  "status": "healthy",
  "apiVersions": {
    "supported": ["v1"],
    "default": "v1"
  }
}
```

### Version Middleware

The API version middleware automatically:
- Extracts version from URL path
- Validates version is supported
- Returns 400 for unsupported versions
- Sets default version if none specified

## Event Schema Versioning

Stream event schemas are published as machine-readable JSON Schema artifacts so downstream consumers can validate payloads and plan compatible upgrades. Event schemas are **versioned independently from package releases** — a schema version bump does not require (and is not tied to) an npm/package version bump.

### Schema Location

Published schemas live under `backend/schemas/` and are named by their schema version:

```
backend/schemas/stream-event.v1.json
```

Each artifact declares its own `$id` (e.g. `https://flowfi.io/schemas/stream-event.v1.json`) and a `version` field so consumers can pin to a specific schema version regardless of the package version they install.

### Backward-Compatibility Rules

Within a **major** schema version (e.g. `v1`), only **additive** changes are allowed:

- ✅ Adding new **optional** properties
- ✅ Adding new enum values only when consumers are documented to tolerate unknown values
- ✅ Relaxing constraints (e.g. widening a `maxLength`)
- ❌ Adding new **required** properties
- ❌ Removing or renaming properties
- ❌ Changing a property's type
- ❌ Tightening constraints (e.g. narrowing an enum, adding `required`)

Any breaking change requires publishing a **new major schema version** (e.g. `stream-event.v2.json`). The previous major version remains published and supported during its deprecation window.

### Consumer Example

Consumers validate a stream event payload against the published schema before processing it:

```javascript
import Ajv from 'ajv';
import schema from 'flowfi-sdk/schemas/stream-event.v1.json' assert { type: 'json' };

const ajv = new Ajv({ strict: false });
const validate = ajv.compile(schema);

const event = {
  version: 'v1',
  type: 'stream.created',
  streamId: '1',
  timestamp: '2024-02-21T00:00:00.000Z',
  payload: { amount: '10000' }
};

if (!validate(event)) {
  console.error('Invalid stream event:', validate.errors);
  throw new Error('Stream event failed schema validation');
}
```

Consumers should reject payloads that fail validation, and should treat an unknown `version` as a signal to upgrade their pinned schema rather than silently accepting the payload.

## Best Practices

### For API Developers

1. **Always version new endpoints** - Never add unversioned routes
2. **Document breaking changes** - Update CHANGELOG.md
3. **Provide migration guides** - Help consumers upgrade
4. **Maintain backward compatibility** - Within a version
5. **Test version isolation** - Ensure versions don't interfere
6. **Version event schemas independently** - Bump schema versions separately from package releases and follow the additive-only rule within a major version

### For API Consumers

1. **Pin to specific version** - Don't rely on default
2. **Monitor deprecation notices** - Check headers and docs
3. **Plan migrations early** - Don't wait until sunset
4. **Test thoroughly** - Before upgrading versions
5. **Use health endpoint** - Check supported versions
6. **Validate event payloads** - Compile the published schema and reject invalid or unknown-version events

## Examples

### Creating a Stream (v1)

```bash
POST /v1/streams
Content-Type: application/json

{
  "sender": "GABC...",
  "recipient": "GDEF...",
  "tokenAddress": "CBCD...",
  "amount": "10000",
  "duration": 86400
}
```

### Subscribing to Events (v1)

```bash
GET /v1/events/subscribe?streams=1&streams=2
Accept: text/event-stream
```

### Unsupported Version

```bash
GET /v2/streams
```

Response:
```json
{
  "error": "Unsupported API version",
  "message": "API version 'v2' is not supported. Supported versions: v1",
  "supportedVersions": ["v1"]
}
```

## Future Considerations

### Version 2 Planning

When planning v2, consider:
- What breaking changes are needed?
- Can they be avoided with optional fields?
- What's the migration complexity for consumers?
- Is a new version necessary or can we extend v1?

### Version Lifecycle Management

- **Current**: v1 (actively maintained)
- **Next**: v2 (when breaking changes are needed)
- **Deprecated**: None currently
- **Sunset**: None currently

## Related Documentation

- [API Documentation](../README.md)
- [Architecture Overview](../../docs/ARCHITECTURE.md)
- [Contributing Guide](../../CONTRIBUTING.md)
