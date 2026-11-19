# 0007. Organization ownership and authorization

## Status

Proposed. Contract and backend owners must both approve before implementation. Review findings and the final decision belong in this record.

## Context

Existing streams name individual Stellar addresses as sender and recipient. An organization can group streams and delegate preparation, but organization membership and on-chain signing authority have different lifecycles.

## Decision proposed

Use backend-owned organization IDs and scoped memberships for grouping, policy, and audit history. Keep wallet ownership and stream authorization with the contract. A viewer can read authorized organization records, an operator can prepare a payment, and an admin can change membership. Enforce tenant and role checks server-side on every organization operation. Wallet holders still approve and sign on the target network. Removing a member revokes app access immediately and requires separate signer rotation if their key has independent wallet authority.

Scope a payment-intent idempotency key to organization and operation. Persist the canonical request fingerprint and intent atomically. Equal retries return the original intent, and a different payload for the same key conflicts. Bind the reviewed network, source wallet, recipient, asset and amount to the intent. Reconcile a submitted transaction on its network before building another. A ledger result on another network must not resolve the intent.

## Alternatives considered

| Option | Trade-off |
| --- | --- |
| Off-chain organization and existing wallet authority | Supports grouping without contract migration. On-chain authorization cannot enforce app roles and a signer may act directly. |
| Organization-controlled Stellar multisig | Enforces wallet thresholds at signing. Requires signer coordination, threshold recovery, and migration to a new sender for future streams. |
| Contract-native organizations and delegated roles | Enforces policy on-chain. Introduces storage, authorization checks, upgrade risk, and indexing changes. |

## Consequences and migration

Add organization, membership, and intent tables and keep existing personal streams readable and usable. Links to historical streams require an explicit, authorized claim of association and leave sender, recipient, and chain-scoped identifiers intact. Keep current API behavior for personal streams and introduce separate organization endpoints. Roll back by disabling organization mutations while preserving audit and reconciliation records. Any later change of on-chain authority needs a separately reviewed migration and recovery plan.

Before accepting, contract and backend owners should verify cross-tenant denial, revoked membership, wrong-network signatures, equal-key retries, and conflicting payloads. Coordinate with the [recurring payment proposal](0008-recurring-payment-execution.md) and [client signing decision](0002-keeper-key-deprecation-client-side-signing.md).
