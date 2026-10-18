import { describe, it, expect } from 'vitest';
import { verifySchemaMigrationCompatibility } from '../src/lib/schema-compatibility-gate.js';

describe('Database Schema Compatibility Release Gate', () => {
  it('approves safe additive schema migrations (expand phase)', () => {
    const safeSql = `
      -- Add optional column
      ALTER TABLE "Stream" ADD COLUMN "metadata" TEXT;
      -- Add non-null column with explicit default
      ALTER TABLE "Stream" ADD COLUMN "retryCount" INTEGER NOT NULL DEFAULT 0;
      -- Add new index
      CREATE INDEX CONCURRENTLY "Stream_metadata_idx" ON "Stream"("metadata");
    `;

    const result = verifySchemaMigrationCompatibility(safeSql);
    expect(result.safeForRollout).toBe(true);
    expect(result.canRollbackApp).toBe(true);
    expect(result.violations.filter((v) => v.severity === 'CRITICAL')).toHaveLength(0);
  });

  it('rejects destructive DROP TABLE statements with critical violation', () => {
    const destructiveSql = `DROP TABLE "LegacyStreams";`;
    const result = verifySchemaMigrationCompatibility(destructiveSql);

    expect(result.safeForRollout).toBe(false);
    expect(result.canRollbackApp).toBe(false);
    expect(result.violations.some((v) => v.reason.includes('Dropping a table'))).toBe(true);
  });

  it('rejects destructive DROP COLUMN statements', () => {
    const dropColumnSql = `ALTER TABLE "Stream" DROP COLUMN "oldField";`;
    const result = verifySchemaMigrationCompatibility(dropColumnSql);

    expect(result.safeForRollout).toBe(false);
    expect(result.violations.some((v) => v.reason.includes('Dropping a column'))).toBe(true);
  });

  it('rejects adding NOT NULL columns without default values', () => {
    const brokenSql = `ALTER TABLE "Stream" ADD COLUMN "requiredSecret" TEXT NOT NULL;`;
    const result = verifySchemaMigrationCompatibility(brokenSql);

    expect(result.safeForRollout).toBe(false);
    expect(result.violations.some((v) => v.reason.includes('NOT NULL column without a DEFAULT'))).toBe(true);
  });

  it('rejects column renaming in a single release step', () => {
    const renameSql = `ALTER TABLE "Stream" RENAME COLUMN "oldName" TO "newName";`;
    const result = verifySchemaMigrationCompatibility(renameSql);

    expect(result.safeForRollout).toBe(false);
    expect(result.violations.some((v) => v.reason.includes('Renaming a column'))).toBe(true);
  });
});
