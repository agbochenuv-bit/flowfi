# Wallet and operator key lifecycle

Assign a named custodian and a backup incident contact to each deployed identity
in the private operational register. Record its public identifier, network,
purpose, authorized actions and rotation date. Store key material in the
custodian's approved secret store. The roles below describe who owns each
decision and can be assigned independently in each environment.

| Identity and owner | What it signs and where custody lives | Rotate or revoke | Control |
| --- | --- | --- | --- |
| Non-custodial wallet · wallet holder | The wallet signs the API authentication challenge and approves on-chain actions as the applicable sender or recipient. Signing material stays with the wallet holder. | Use wallet recovery or replace the account's authorized signer where possible. For a new address, review each stream's permitted transfer or closure operation. Existing streams and API tokens do not automatically follow a new wallet address. | [Wallet authentication](../../backend/docs/AUTHENTICATION.md), [contract authorization](../../contracts/stream_contract/src/lib.rs) |
| Explicitly custodial wallet · approved custodian | A separately approved service signs for a user only within its documented mandate. A helper taking a sender secret does not establish a custody offering. Keep custody credentials separate from funding and operator keys. | Suspend signing on incident; recover or replace the signer under the custody approval and verify account thresholds and stream authority. Record authorization, consent, recovery ownership and incident notification before enabling custody. | [Sender-signing helper](../../backend/src/services/sorobanService.ts), [contract authorization](../../contracts/stream_contract/src/lib.rs) |
| Service submitter / keeper · backend operator | A funded service identity can pay for and submit its configured transactions. Contract-required wallet authorization still applies. | Pause submissions; confirm the new public key, network, funding and permitted operations; disable access to the old secret and remove any obsolete signer grants. | [Service signer configuration](../../backend/.env.example), [on-chain authorization](../../contracts/stream_contract/src/lib.rs) |
| Deployer and contract admin · release operator and contract governance | The deployer submits releases; the configured admin authorizes privileged contract operations. Treat them as independent roles and keep each network's keys separate. | Replace the deployer credential in the release environment. For admin changes, verify the deployed contract version and use its authorized transfer path, including acceptance where applicable. Verify the final admin on-chain before retiring access to the old signer. | [Deployment](../../scripts/deploy.sh), [contract admin controls](../../contracts/stream_contract/src/lib.rs), [fee governance](../adr/0005-fee-governance.md) |
| API session signer · API operator | Signs API session credentials after wallet proof. It has no transaction signing authority. | Stage a fresh key in the verification set, switch the active key, then retire the old key after the maximum session lifetime and skew allowance. On compromise, remove it from every verifier immediately and have affected users reauthenticate. | [JWT rotation runbook](../../SECURITY.md#rotation-runbook) |
| Webhook HMAC signer · subscription owner and backend operator | The backend signs subscriber payloads using a per-subscription secret. The receiver verifies the raw body and keeps its copy in its own secret store. | Coordinate regeneration and receiver cutover. Disable delivery while coordinating if needed. Revoke receiver acceptance of a compromised secret and reconcile any missed events from the ledger. | [Authenticated webhook routes](../../backend/src/routes/v1/webhook.routes.ts), [delivery implementation](../../backend/src/services/webhook.service.ts) |

## Suspected compromise

1. Notify the appropriate owner through the private incident channel. Record
   public IDs, network, timestamps, and transaction hashes. Follow the
   [security reporting policy](../../SECURITY.md#reporting-a-vulnerability).
2. Contain the affected flow. Pause service submissions or webhook delivery,
   reject compromised JWT keys, or coordinate wallet recovery with the holder
   or approved custodian. Treat wallet authorization and existing API sessions
   as separate incident surfaces.
3. Replace credentials through the owning control. Verify with a new signature
   and a rejected retired credential. For a wallet or contract admin, verify
   effective authority on-chain after the change.
4. Reconcile activity since the suspected exposure, including transactions,
   indexed stream events and webhook deliveries. Record gaps and restore service
   only after the signer owner and incident lead approve the evidence.
