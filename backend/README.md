# Backend

This directory contains the backend services for the project, including the API server, indexer, and supporting workers.

## Getting started

```bash
npm install
npm run dev
```

## Testing

```bash
npm test
```

### Indexer soak / stability test

The indexer includes a long-running soak test that drives event polling, SSE fanout, webhook dispatch, and replay under sustained representative traffic. It asserts that memory growth and queue depths stay within published bounds over a repeatable window.

Run it with:

```bash
npm run test:soak
```

Environment knobs (all optional):

| Variable | Default | Description |
| --- | --- | --- |
| `SOAK_DURATION_MS` | `30000` | Length of the soak window in milliseconds. |
| `SOAK_TICK_MS` | `50` | Interval between simulated traffic ticks. |
| `SOAK_MAX_HEAP_GROWTH_BYTES` | `67108864` (64 MiB) | Maximum allowed heap growth across the window. |
| `SOAK_MAX_QUEUE_DEPTH` | `1000` | Maximum allowed depth for any queue (polling backlog, SSE subscriber buffers, webhook dispatch, replay). |

Thresholds and reproduction steps are documented in [`docs/indexer-operations.md`](docs/indexer-operations.md).

## Documentation

- [Indexer operations](docs/indexer-operations.md)
- [Observability](docs/observability/README.md)
- [API hardening](docs/api-hardening.md)
- [Authentication](docs/AUTHENTICATION.md)
