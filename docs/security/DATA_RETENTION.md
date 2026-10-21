# Off-Chain Data Inventory and Retention

## Principles

Stellar ledger state and transaction history are the authoritative audit record. Keep only the off-chain chain facts needed for indexing, reconciliation, and product queries. Wallet public keys are public identifiers, but they remain linkable data and must be treated as sensitive. Never place private keys, webhook secrets, full payloads, or destination URLs in application logs.

A deletion request must remove optional integration data immediately. It must not rewrite or obscure on-chain facts. Where a relational mirror prevents deletion without losing required history, retain the minimum chain-derived fields and record the reason in the support case rather than claiming the account was erased.

## Inventory

| Data | Location and linkage | Purpose | Retention / deletion behavior |
|---|---|---|---|
| Wallet identity | `User.publicKey`; linked by `Stream.sender` and `Stream.recipient` | Authentication and stream lookup | Retain while linked to an active stream and for at most 90 days after the last linked stream becomes terminal. Then erase the off-chain user mapping when no retained stream references it. No standalone account-erasure endpoint or scheduled mirror cleanup currently exists. |
| Stream mirror | `Stream` sender/recipient, token, amount, and timing fields | Fast reads of current on-chain state | Rebuildable from the ledger. Retain active stream state; delete terminal stream mirrors after 90 days. Preserve ledger checkpoints and transaction/event audit evidence independently. No scheduled stream-mirror cleanup currently exists. |
| Alert history | `AlertHistory.streamId`, alert type, and send time | Prevent duplicate stream runway notifications | Delete rows older than 90 days; an hourly worker enforces this. |
| Ledger audit | `StreamEvent`, `LedgerCheckpoint`, transaction hashes, ledger sequences, event metadata | Reconciliation, reorg detection, and proof of indexed chain history | Retain as chain-derived audit evidence. Do not alter or delete to satisfy a personal-data request; the immutable ledger remains authoritative. Review event metadata before adding off-chain values. |
| Indexer quarantine | `IndexerDeadLetterEvent.payload` (raw event envelope) and `errorMessage` | Replay and diagnosis of malformed events | Restrict to operators. Delete after successful replay or discard; unresolved records remain only while needed to resolve the indexing failure. The database currently has no automatic expiry for these rows. |
| Webhook configuration | `WebhookSubscription.userAddress`, `targetUrl`, `secretKey`, and event filters | User-configured delivery | Retain until the owner deletes the subscription. Deletion hard-deletes the subscription and cascades to delivery rows. Rotate a secret immediately on suspected exposure. |
| Webhook delivery history | `WebhookDelivery.payload`, response status, attempts, and error | Troubleshooting delivery | Delete immediately with its subscription. For active subscriptions, delete rows older than 30 days; the hourly retention worker enforces this. Keep errors generic and never store raw transport exceptions. |
| Application logs | Winston JSON to stdout/stderr; request ID and operational messages | Service operations and incident diagnosis | Winston redacts Stellar public/secret keys, URLs, bearer/JWT values, and sensitive credential fields. Avoid logging delivery payloads. Configure the hosting log sink to expire logs within 30 days; the application does not control sink retention. |
| Exports | On-demand CSV/JSON streaming from `Stream` and `StreamEvent`; no export table or object-storage workflow found | User data access | Stream directly to the authenticated requester; do not persist export files. If persistent exports are introduced, scope to the requester, encrypt at rest, and expire within 24 hours. |
| Analytics | Timescale `stream_flow_snapshots`, `hourly_protocol_metrics`, and `daily_protocol_metrics`; snapshots are protocol-level aggregates without wallet identifiers | Product and operational reporting | Keep raw snapshots for 90 days; Timescale retention removes older rows. Preserve aggregate views for historical reporting. Do not add wallet identifiers to analytics snapshots. |

## Deletion Procedure

1. Authenticate the requester by wallet ownership; never accept a wallet address alone as proof of identity.
2. Delete webhook subscriptions through the API. The database cascade removes all associated delivery payloads and history in the same deletion.
3. Remove other optional off-chain profile data, if introduced, and revoke active credentials. Record completion without copying the deleted values into the case log.
4. Preserve ledger checkpoints, transaction hashes, and minimum chain-derived event facts required for audit/reconciliation. Explain that on-chain records cannot be erased.
5. Ensure the production log sink's retention setting is 30 days or less and verify it during deployment reviews.

## Enforcement Gaps

Webhook subscription deletion, hourly expiry of delivery rows older than 30 days, and hourly expiry of alert records older than 90 days are enforced in the service/worker layer. Timescale expires raw analytics snapshots after 90 days. Dead-letter cleanup and log-sink expiry remain deployment/operator requirements and are not currently enforced by an in-app scheduled job.

The 90-day expiry of terminal stream mirrors and unreferenced wallet mappings is the retention target but is not yet automated. Until that cleanup is implemented, do not claim full account erasure; route verified requests to the data owner and preserve the on-chain audit record.
