-- Add composite index on (stream_id, ledger_sequence) to support deterministic
-- event ordering within a stream. Queries that list all events for a stream
-- ordered by ledger sequence (i.e. blockchain-canonical ordering) will use this
-- index rather than falling back to a full-table scan or the timestamp index.
--
-- The ordering guarantee is:
--   ledger_sequence ASC, id ASC  → chronological (oldest-first)
--   ledger_sequence DESC, id DESC → reverse chronological (newest-first)
--
-- This index complements the existing (streamId, timestamp) index. Timestamp is
-- a Unix integer set from wall-clock time at indexing time and can collide across
-- events in the same ledger; ledger_sequence is the canonical blockchain total
-- order. Both indices are kept: timestamp for calendar-range scans,
-- (stream_id, ledger_sequence) for lifecycle ordering queries.

-- CreateIndex
CREATE INDEX IF NOT EXISTS "StreamEvent_streamId_ledgerSequence_idx"
  ON "StreamEvent"("streamId", "ledgerSequence");
