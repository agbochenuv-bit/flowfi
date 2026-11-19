# Partner onboarding and go-live

Run this checklist from a fresh checkout against a clean Testnet deployment
before publishing integration instructions or enabling production traffic.
Record the commit, environment, test results and redacted reconciliation
evidence in the private release record.

| Setting | Testnet | Production |
| --- | --- | --- |
| API | Operator-provided Testnet HTTPS origin and auth audience | Approved production HTTPS origin and auth audience |
| Chain | Testnet wallet, RPC and deployed contract | Mainnet wallet, RPC and deployed contract |
| Credentials | Disposable signer and Testnet-only secret-store entries | Approved signer custody, least privilege and production-only entries |
| Receiver | Dedicated public HTTPS endpoint and subscription | Separate public HTTPS endpoint, subscription and HMAC secret |

## Configure and verify

1. Confirm the deployed contract and network with the operator. Use the
   [wallet challenge flow](../../backend/docs/AUTHENTICATION.md) to get a
   bearer token. Keep the wallet signature operation with the wallet.
   Exclude tokens, keys and webhook secrets from logs and shell history.
2. Send an authenticated `POST /v1/webhooks` with a JSON body such as
   `{"targetUrl":"https://receiver.example.org/flowfi","eventTypes":["STREAM_CREATED"]}`.
   Replace the example URL and confirm the event names with the operator.
   Store the returned `secretKey` in the receiver's secret store and record
   the subscription ID separately. Regenerate a lost key with
   `POST /v1/webhooks/{id}/secret` and coordinate receiver cutover.
3. Run the sample verification tests from the root of the fresh checkout.

   ```bash
   node --test docs/api/examples/verify-webhook.test.mjs
   ```

4. Use the [receiver verifier](examples/verify-webhook.mjs) before parsing.
   Pass a size-bounded raw Buffer, the single `X-FlowFi-Signature` header
   and the subscription secret. Persist valid events idempotently before
   returning 2xx. Use verified chain event identity, scoped by network and
   contract. The unsigned `X-FlowFi-Delivery-ID` can correlate attempts.
5. Call `POST /v1/webhooks/{id}/test`. Require `result.success` and a
   receiver record for `TEST_PING`. Inspect attempt status using
   `GET /v1/webhooks/{id}/deliveries`. The dispatcher reuses its signature
   timestamp across retries, and attempts beyond the sample's five-minute
   freshness window require reconciliation.

## Reconcile and approve production traffic

- [ ] Create, withdraw and cancel a small Testnet stream with an approved
  signer. See the [Testnet lifecycle suite](../../backend/e2e/testnet/README.md).
- [ ] Compare confirmed contract events with
  `GET /v1/streams/{streamId}/events` and receiver records. Match network,
  contract, transaction hash, stream ID, event type and amounts in base
  units. Demonstrate recovery of a missed event without duplicate accounting.
- [ ] Confirm the deployed indexer dispatches subscribed ledger events. A
  test ping verifies receiver connectivity.
- [ ] Exercise wrong-wallet access, wrong-network signing, receiver failure,
  credential rotation and duplicate handling. Assign reconciliation and
  alert ownership and agree on how to escalate discrepancies.
- [ ] Have the integrator and deployment owner approve clean-environment
  evidence, retention, production credentials and rollback. Begin with a
  small approved Mainnet flow. To contain a failure, coordinate subscription
  disablement via `PATCH /v1/webhooks/{id}` with `{"isActive":false}` and
  reconcile the gap before resuming.
