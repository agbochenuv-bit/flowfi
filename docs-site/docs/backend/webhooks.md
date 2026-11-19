---
title: Webhooks
---

# Webhooks

Subscription routes under `/v1/webhooks` require an authenticated wallet.
Register a public HTTPS receiver with `targetUrl` and `eventTypes`.
Creation returns the generated `secretKey` once. Store it securely and
use `POST /v1/webhooks/{id}/secret` to regenerate it.

The dispatcher sends an HTTP POST with these headers:

- `X-FlowFi-Signature` contains `t=<unix-seconds>,v1=<lowercase-hex-hmac>`.
- `X-FlowFi-Event` identifies the event type.
- `X-FlowFi-Delivery-ID` correlates attempts in one delivery.

Compute HMAC-SHA256 with the subscription secret over the ASCII timestamp
followed by a dot and the exact raw request body. Verify before parsing
and use constant-time comparison. Process verified events idempotently
and reconcile missed events against the ledger.

The dispatcher makes up to five attempts, with delays of one minute, five
minutes, fifteen minutes and one hour between attempts. It reuses the
signature timestamp, so a receiver freshness window can reject late
attempts. Inspect history at `GET /v1/webhooks/{id}/deliveries`.

Use `PATCH /v1/webhooks/{id}` with `{"isActive":false}` to disable a
subscription. Deletion also removes stored delivery history. Verify
connectivity with `POST /v1/webhooks/{id}/test` and check the result
as well as the HTTP status.
