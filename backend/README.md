# Backend

This directory contains the backend service for the application.

## Getting started

See the project root README for setup instructions.

## Testing

### Production-scale query regression suite

The production-scale query regression suite measures representative stream,
event, export, and analytics queries against realistic data volume so that
performance regressions are caught before release.

Because the suite seeds a large dataset and runs long, it is **opt-in** and is
not part of the default fast test run. Run it explicitly:

```bash
# Run the full production-scale regression suite
npm run test:regression
```

#### Repeatable dataset and query plans

The suite records a deterministic dataset definition and the query plans for
each representative query. Runs are compared against these recorded fixtures so
results are stable and comparable across releases. Fixtures live alongside the
suite and are regenerated only when the schema or query set intentionally
changes.

#### Regression thresholds

Each query has a bounded regression threshold (maximum allowed latency and plan
regression). A run fails when a query exceeds its threshold, and passes when it
is at or just under the threshold. Empty or minimal datasets are handled as a
boundary case and must not error.

#### Failure and boundary coverage

The suite includes focused coverage for:

- threshold exceeded (regression detected)
- at / just under threshold (passes)
- empty or minimal dataset (no error)

#### Scheduling

In addition to manual runs, the suite is intended to run on a schedule (e.g.
nightly) in CI rather than on every pull request.
