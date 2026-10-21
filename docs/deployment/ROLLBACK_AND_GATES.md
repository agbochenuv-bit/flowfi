# Deployment Health Gates and Verified Rollback Procedure

## 1. Overview and Core Philosophy

FlowFi operates a hybrid architecture composed of:
- **Off-chain Reversible Components:** Backend API/Worker services, Frontend SPA/SSR pages, Redis caches.
- **Relational Storage:** PostgreSQL managed via Prisma migrations (expand-and-contract model).
- **On-chain Immutable Components:** Soroban smart contracts on the Stellar network.

This document defines the automated health gates, verification criteria, and distinct rollback protocols for each tier. Critically, **reversible application rollbacks must be strictly separated from irreversible on-chain deployment decisions.**

---

## 2. Deployment Health Gates Matrix

Every release candidate must pass through four sequential health gates prior to traffic shift:

| Gate | Target Component | Success Criteria | Failure Action |
|------|------------------|------------------|----------------|
| **Gate 1: Schema Compatibility** | PostgreSQL / Prisma | Target schema is backwards-compatible with current running backend code (no destructive drops) | Abort deployment immediately before migration |
| **Gate 2: Container Readiness** | Backend HTTP / Worker | `GET /health/ready` returns 200 within 30s; DB connection pool wait time < 50ms | Abort rollout; retain existing pod traffic |
| **Gate 3: Indexer Synchronization** | Soroban Event Worker | Indexer lag `< 5` ledgers relative to network tip within 60s of startup | Stop traffic shifting; isolate worker |
| **Gate 4: Frontend Asset Integrity**| Next.js Client Bundle | Critical chunks return 200 with matching Content-Security-Policy headers | Revert DNS/CDN routing to previous static artifact |

---

## 3. Reversible Application Rollback (Off-chain)

Backend and Frontend services are fully stateless and reversible.

### Backend Rollback Procedure
1. **Trigger:** `flowfi_http_requests_total{status=~"5.."}` error rate exceeds 1% over 2 minutes OR Gate 2/3 fails.
2. **Action:**
   - Kubernetes / Render / ECS deployment command: roll back image tag to `previous_stable_digest`.
   - Clear Redis query caches if format was altered: `flowfi:cache:*`.
   - Verify previous pods return healthy on `/health/ready`.

### Frontend Rollback Procedure
1. **Trigger:** Client-side Sentry exception spike or CSP violation reports.
2. **Action:**
   - Vercel / Cloudflare: Instantly promote previous successful deployment aliasing to production.
   - Invalidate CDN edge caches for Next.js static bundles.

---

## 4. Database Migration Safety: Expand-and-Contract

Database migrations must never introduce breaking changes in a single release.

### Rules:
1. **Expand First:** Add new columns as optional/nullable or with defaults. Never rename or drop columns while older backend replicas are live.
2. **Migrate Data:** Backfill data asynchronously if required.
3. **Contract Later:** Only drop columns or add `NOT NULL` constraints in a subsequent release after all old backend replicas have been decommissioned.

### Database Rollback Strategy:
- **During Rollout Window:** Because migrations adhere to the expand rule, the previous backend version can continue reading and writing to the updated schema without rollbacks of the schema itself.
- **Irreversible Schema Alterations:** If a migration failed mid-way, apply compensating SQL forward migrations rather than destructive `DOWN` scripts in production.

---

## 5. Soroban Smart Contract Deployments (Irreversible Decisions)

Smart contracts deployed to the Stellar network are permanent and immutable.

### On-Chain Separation Rules:
1. **On-chain writes are irreversible:** Once a WASM byte code is deployed or state modified on ledger, it cannot be "rolled back" via git checkout or container restart.
2. **Protocol Pausing (Reversible Mitigation):**
   - In the event of contract anomalies, execute `emergency_pause()` signed by the admin multisig.
   - This reversibly halts stream creations and claims while preventing fund loss.
3. **Contract Upgrades:**
   - Execute upgrades via the contract's governance upgrade mechanism.
   - Point the backend `CONTRACT_ADDRESS` to the new contract address only after full indexing replay verification.
