# Incident evidence and post-incident review

Copy this template into the restricted incident tracker. Use UTC and stable internal references. Leave unknown values marked **unknown** and assign an owner to resolve them where possible.

Use aggregate impact counts and service or role references. Keep evidence in approved, access-controlled storage and link the minimum sanitized excerpt needed for the review. Omit credentials, private keys, bearer tokens, raw request bodies, customer identifiers, and wallet addresses. Public transaction hashes and stream IDs may still identify participants. Include them only where necessary for reconciliation and keep them in restricted evidence. Follow the [data retention policy](../security/DATA_RETENTION.md), including applicable expiry and legal holds.

## Summary and impact

- Incident reference, severity, current status, and incident lead
- Affected environment, Stellar network, services, and build or release
- Detection time, impact start and end, and confidence in each timestamp
- Affected operations, aggregate customer or stream counts, and impact on balances, withdrawals, settlement, or data freshness
- Known unaffected operations or networks, with evidence
- Customer communication owner and restricted reference to approved updates

## UTC timeline

| Time (UTC) | Observation or action | Responsible role | Sanitized evidence reference |
| --- | --- | --- | --- |
| YYYY-MM-DD HH:MM:SS | Detection, decision, mitigation, recovery, or verification | Role | Restricted link |

## Chain and indexer evidence

- Record the network and the observed ledger range or sequence. Capture the relevant deployment and successful, failed, pending, or unknown transaction outcomes. Record each observation's source and UTC time.
- Record the indexer cursor, chain head, observed lag, and any dead-letter or replay range. Distinguish RPC observations from indexed values.
- Record accounting or reconciliation checks and their results. For an ambiguous submission, record how it will be resolved before retrying. If the chain was unaffected, record the check that supports that conclusion.

## Recovery and verification

| Mitigation or recovery action | Owner | Observed result | Verification evidence or remaining uncertainty |
| --- | --- | --- | --- |
| Record the runbook step or approved change | Role | Result | State the check, expected result, and observation |

Document rollback, replay or resumption decisions and their approval references. Verify the intended network, successful on-chain outcomes where relevant, restored indexer progress, and affected user workflows before closing. Record the monitoring window, its owner, and anything that remains degraded.

## Post-incident review

Summarize the trigger, contributing conditions, detection and response gaps, and what helped. Distinguish confirmed findings from hypotheses and cite the sanitized evidence. Record open questions with their owners.

| Follow-up | Accountable owner | Due date (UTC) | Verification criteria | Tracking reference and status |
| --- | --- | --- | --- | --- |
| Describe a specific change | Role | YYYY-MM-DD | Reproducible check and expected result | Internal issue and status |

Record the review date, participating roles, who signs off on recovery, and who verifies follow-ups.

## Runbooks

- [Rollback and deployment gates](../deployment/ROLLBACK_AND_GATES.md)
- [Indexer operations and recovery](../../backend/docs/indexer-operations.md)
- [Emergency contract controls](../contracts/EMERGENCY_CONTROLS.md)
