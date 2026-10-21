# Resumable Range-Based Historical Backfill

## Overview
FlowFi provides an explicit historical backfill mode to process bounded ledger ranges (`[fromLedger, toLedger]`) independently of the live indexer cursor (`IndexerState`). This allows operators to backfill historical contract events without affecting, regressing, or pausing the live indexing pipeline.

## Externally Observable Behavior
- **Independent Execution:** Backfill jobs operate on a dedicated `BackfillJob` state model and do not mutate or regress `IndexerState`. Live indexing continues uninhibited.
- **Progress Tracking & Metadata:** Each backfill job tracks its progress (`currentLedger`, `eventsProcessed`, `eventsFailed`, `percentComplete`, `ledgersRemaining`, `estimatedCompletionAt`, and status (`PENDING`, `RUNNING`, `PAUSED`, `COMPLETED`, `FAILED`, `CANCELLED`)).
- **Safe Restart / Resumability:** Interrupted or paused backfill jobs can be resumed from their last processed ledger (`currentLedger`) without reprocessing completed ledgers.
- **Protection from Duplicate Writes:** Re-processing events via backfill utilizes the existing `StreamEvent` unique constraint `@@unique([transactionHash, eventType])` and `Stream` upsert logic. Duplicate writes are safely skipped, making overlapping runs and resumption idempotent at the database layer.

## Operational Controls (Admin API)

All endpoints require Admin authentication (`Authorization: Bearer <admin-jwt>`) and are rate-limited.

### 1. Start a Backfill Job
- **Endpoint:** `POST /v1/admin/indexer/backfill`
- **Request Body:**
  ```json
  {
    "fromLedger": 100000,
    "toLedger": 150000,
    "name": "historical-q1-backfill"
  }
  ```
- **Response (202 Accepted):** Returns job ID and initial status. Rejects with `409 Conflict` if an overlapping backfill range is already running or pending.

### 2. List Backfill Jobs
- **Endpoint:** `GET /v1/admin/indexer/backfill?status=RUNNING&limit=50&offset=0`
- **Response (200 OK):** Paginated list of backfill jobs.

### 3. Get Backfill Progress & Status
- **Endpoint:** `GET /v1/admin/indexer/backfill/:id`
- **Response (200 OK):** Detailed job metadata, percentage complete, and estimated completion time.

### 4. Pause a Running Backfill Job
- **Endpoint:** `POST /v1/admin/indexer/backfill/:id/pause`
- **Response (200 OK):** Pauses processing after the current batch.

### 5. Resume a Paused Backfill Job
- **Endpoint:** `POST /v1/admin/indexer/backfill/:id/resume`
- **Response (200 OK):** Resumes execution from `currentLedger`.

### 6. Cancel a Backfill Job
- **Endpoint:** `POST /v1/admin/indexer/backfill/:id/cancel`
- **Response (200 OK):** Permanently stops the backfill job.

## Operational Guidelines for Large Ranges
- **Range Sizing:** For very large ledger ranges (e.g., millions of ledgers), operators should chunk ranges into manageable windows (e.g., 500,000 ledgers each) to facilitate monitoring and operational control.
- **RPC Rate Limits:** Ensure Soroban RPC provider rate limits and concurrency limits are respected when running concurrent backfills and live indexing.
- **Concurrent Live Indexing:** Backfill and live indexing can run simultaneously. Database connection pools and indexing workers handle concurrent event upserts efficiently via unique constraints.
