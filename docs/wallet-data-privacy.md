# Wallet data export and deletion

Open **Wallet data privacy** in Settings after signing in with your wallet.
Download a JSON export or confirm deletion. The same operations are available
under `/v1/privacy` with the wallet access token from the normal sign-in
challenge. Each operation uses the wallet in the token. SSE tickets are scoped
to event subscriptions and cannot authorize privacy requests.

| Request | Result |
|---|---|
| `POST /v1/privacy/export` | JSON attachment with webhook configuration, delivery metadata and an export receipt |
| `POST /v1/privacy/deletion` with `{"confirm":true}` | Removes the wallet's webhook subscriptions and delivery history and returns a completion receipt |
| `GET /v1/privacy/receipts/{id}` | Looks up a completion receipt owned by the authenticated wallet |

Exports omit webhook signing keys, raw payloads and downstream error text.
Deletion removes the entire eligible record, including these fields. A
request with no eligible records completes with counts of zero. A completion
receipt has an ID, wallet address, operation, UTC timestamp and record counts.
The API returns 503 when it cannot confirm completion. Deletion and its
receipt commit together, and a transaction failure rolls both back. Retrying
is safe and creates a new receipt for the records found on that attempt.
Delivery requests already dispatched can still reach the webhook receiver.

The Stellar ledger is public and immutable. FlowFi retains its local chain
projection, including wallet linkage rows needed by stream foreign keys,
stream state, transfers and events, checkpoints and indexer recovery data
for accounting and replay. FlowFi also retains minimal completion receipts
for auditing. The operation applies to the live database. Operational logs,
backups and third-party copies follow their own retention lifecycle. Browser
preferences are local to the device and can be cleared with its site data.

Apply the privacy receipt migration before using the endpoints. With a
disposable PostgreSQL database, apply the schema, set `DATABASE_URL`, then run
`npx vitest run tests/integration/privacy.test.ts` from the backend directory.
