# Off-Chain Data Inventory and Retention

## Principles

Stellar ledger state and transaction history are the authoritative audit record. Keep only the off-chain chain facts needed for indexing, reconciliation, and product queries. Wallet public keys are public identifiers, but they remain linkable data and must be treated as sensitive. Never place private keys, webhook secrets, full payloads, or destination URLs in application logs.

A deletion request must remove optional integration data immediately. It must not rewrite or obscure on-chain facts. Where a relational mirror prevents deletion without losing required history, retain the minimum chain-derived fields and record the reason in the support case rather than claiming the account was erased.

## Inventory

Owners below are accountable roles. The deployment owner assigns those roles
to named contacts before reviewing a product or operations change. A target
describes the intended policy. An enforced rule has a linked implementation.

| Field family and store | Purpose and linkability | Owner and policy/control | Retention and deletion constraint |
|---|---|---|---|
| Postgres `User.publicKey`, internal user ID and row timestamps | Wallet identity, authentication and stream joins | Backend data owner · [Prisma relationships](../../backend/prisma/schema.prisma) | Keep while linked to active or retained streams. Target erasure after the last terminal stream's 90-day window and removal of its references. No automatic wallet cleanup. |
| Postgres `Stream` sender, recipient, stream and token IDs, amounts, balances, schedule and status | Wallet-linked mirror for current product reads | Backend data owner · [stream schema](../../backend/prisma/schema.prisma) | Keep active mirrors. Terminal mirrors have a 90-day target, with no automatic purge. Review event foreign keys and preserve audit evidence before removing any mirror. |
| Postgres `StreamEvent`, `LedgerCheckpoint`, `IndexerState` | Stream ID, tx/ledger IDs, event amount, time and metadata support canonical reconciliation and replay | Indexer operator · [cursor and replay policy](../adr/0003-event-indexer-cursor-pagination-and-dead-letter.md) | Preserve required chain-derived audit evidence and checkpoints. Minimize off-chain metadata. Ledger records remain public after off-chain deletion. |
| Postgres dead letter and backfill rows | Event/tx IDs, ledger ranges, raw event envelopes, errors and attempt counters can identify wallets indirectly | Indexer operator · [indexer operations](../../backend/docs/indexer-operations.md) | Limit access to operators. Remove quarantined payloads after replay or discard. No automatic expiry for unresolved rows or backfill history. |
| Postgres `AlertHistory` stream ID, alert type and send time | Linked by stream ID; suppresses repeat alerts | Backend operator · [expiry queries](../../backend/src/services/webhook.service.ts) | Hourly cleanup deletes rows strictly older than 90 days. |
| Postgres `WebhookSubscription` wallet address, destination URL, secret, event filters, status and timestamps | Routes signed events to a wallet's subscriber | Backend operator and subscription owner · [authenticated webhook routes](../../backend/src/routes/v1/webhook.routes.ts) | Keep until owner deletes the subscription; rotate on exposure. Restrict database access and confirm storage encryption in the deployed version. |
| Postgres `WebhookDelivery` subscription ID, event/payload, attempt/status/error and delivery timestamps | Delivery diagnostics; payload may contain wallet-linked data | Backend operator · [expiry queries](../../backend/src/services/webhook.service.ts), [cascade](../../backend/prisma/schema.prisma) | Delete immediately on subscription deletion. Hourly cleanup deletes remaining rows strictly older than 30 days. The receiver owns its copy under its own policy. |
| Winston stdout/stderr and hosting log sink | Request IDs, timings and operation/error context can be joined with other evidence | Platform operations · [redaction control](../../backend/src/logger.ts) | Configure sink expiry within 30 days. App redaction is defense in depth; keep credentials, full payloads and webhook URLs out of log inputs. Hosting expiry is externally operated. |
| CSV/JSON response and requester downloads | Wallet-scoped stream, token, amount, transaction and timing data for bookkeeping | API owner · [export service](../../backend/src/services/export.service.ts) | Stream on demand. The export service implements streaming; verify that the deployment exposes it. No repository-defined server-side export store. The requester controls downloads; a new hosted export store requires encryption, requester scoping and expiry within 24 hours. |
| Timescale snapshots and hourly/daily views | Token address, time bucket, stream counts, aggregate amounts and velocity for reporting | Analytics data owner · [Timescale schema](../../backend/prisma/migrations/20261001000000_add_timescaledb_analytics/migration.sql), [90-day policy](../../backend/prisma/migrations/20261018000000_retention_and_webhook_tables/migration.sql) | No wallet IDs in these tables. Timescale expires raw snapshots after 90 days when the retention migration is applied and its policy is running. Aggregate views are preserved. |
| Managed Postgres backups, snapshots and recovery logs, where enabled | May contain every database field above, including deleted rows and webhook secrets | Platform operations · [backup and restore policy below](#backup-and-restore-policy) | Expire via the configured backup/PITR window; confirm each copy's expiry before making an erasure commitment. |

## Backup and restore policy

Production backup locations, retention periods, and recovery-log windows are
deployment-specific and are not established by this repository. Before
launch, Platform Operations records the approved windows for each copy,
verifies encryption and restore-access controls, and keeps verification
evidence in the private deployment record. Restore into an isolated
environment. Before reopening traffic or restarting delivery workers,
reapply verified deletions and review webhook credentials restored from the
snapshot. Record when the final backup containing deleted data expires.

## Deletion Procedure

1. Authenticate the requester by wallet ownership; never accept a wallet address alone as proof of identity.
2. Delete webhook subscriptions through the API. The database cascade removes all associated delivery payloads and history in the same deletion.
3. Remove other optional off-chain profile data, if introduced, and revoke active credentials. Record completion without copying the deleted values into the case log.
4. Preserve ledger checkpoints, transaction hashes, and minimum chain-derived event facts required for audit/reconciliation. Explain that on-chain records cannot be erased.
5. Ensure the production log sink's retention setting is 30 days or less and verify it during deployment reviews.

## Enforcement Gaps

Webhook subscription deletion, hourly expiry of delivery rows older than 30 days, and hourly expiry of alert records older than 90 days are enforced in the service/worker layer. Verify raw analytics expiry and backup retention in the deployed environment. Dead-letter cleanup and log-sink expiry remain deployment/operator requirements and are not currently enforced by an in-app scheduled job.

The 90-day expiry of terminal stream mirrors and unreferenced wallet mappings is the retention target but is not yet automated. Until that cleanup is implemented, do not claim full account erasure; route verified requests to the data owner and preserve the on-chain audit record.
