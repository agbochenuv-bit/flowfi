#!/usr/bin/env node
/**
 * Schema Compatibility CI Gate
 *
 * Scans all Prisma migration SQL files against the expand-and-contract safety
 * rules defined in src/lib/schema-compatibility-gate.ts and exits non-zero if
 * any critical violations are found.
 *
 * Usage:
 *   npx ts-node --esm scripts/check-schema-compat.ts
 *   # or via the npm script:
 *   npm run check:schema-compat
 *
 * Add to CI (GitHub Actions example):
 *   - name: Schema compatibility gate
 *     run: npm run check:schema-compat
 *     working-directory: backend
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifySchemaMigrationCompatibility } from '../src/lib/schema-compatibility-gate.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const MIGRATIONS_DIR = path.join(__dirname, '..', 'prisma', 'migrations');

interface ScanResult {
  migrationName: string;
  sqlPath: string;
  safeForRollout: boolean;
  canRollbackApp: boolean;
  violations: Array<{
    statement: string;
    reason: string;
    severity: 'CRITICAL' | 'WARNING';
  }>;
  summary: string;
}

/**
 * Scan all migration directories and return per-migration check results.
 */
function scanMigrations(migrationsDir: string): ScanResult[] {
  if (!fs.existsSync(migrationsDir)) {
    console.error(`[schema-compat] Migrations directory not found: ${migrationsDir}`);
    console.error('[schema-compat] Skipping check (no migrations present).');
    return [];
  }

  const entries = fs.readdirSync(migrationsDir, { withFileTypes: true });
  const results: ScanResult[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;

    const sqlPath = path.join(migrationsDir, entry.name, 'migration.sql');
    if (!fs.existsSync(sqlPath)) continue;

    const sql = fs.readFileSync(sqlPath, 'utf8');
    const checkResult = verifySchemaMigrationCompatibility(sql);

    results.push({
      migrationName: entry.name,
      sqlPath,
      ...checkResult,
    });
  }

  return results;
}

/**
 * Print results to stdout/stderr and return an exit code.
 * Exit 0 = all migrations pass (warnings are logged but not fatal).
 * Exit 1 = one or more critical violations detected.
 */
function reportAndExit(results: ScanResult[]): never {
  if (results.length === 0) {
    console.log('[schema-compat] No migration files found. Gate passed (nothing to check).');
    process.exit(0);
  }

  let hasCritical = false;
  let checkedCount = 0;
  let passedCount = 0;
  let warnCount = 0;

  for (const result of results) {
    checkedCount += 1;

    const criticals = result.violations.filter((v) => v.severity === 'CRITICAL');
    const warnings = result.violations.filter((v) => v.severity === 'WARNING');

    if (criticals.length > 0) {
      hasCritical = true;
      console.error(`\n[FAIL] ${result.migrationName}`);
      for (const v of criticals) {
        console.error(`  [CRITICAL] ${v.reason}`);
        console.error(`    SQL: ${v.statement.slice(0, 200)}`);
      }
    }

    if (warnings.length > 0) {
      warnCount += 1;
      console.warn(`\n[WARN] ${result.migrationName}`);
      for (const v of warnings) {
        console.warn(`  [WARNING] ${v.reason}`);
        console.warn(`    SQL: ${v.statement.slice(0, 200)}`);
      }
    }

    if (criticals.length === 0) {
      passedCount += 1;
    }
  }

  console.log(`\n[schema-compat] Checked ${checkedCount} migration(s): ${passedCount} passed, ${warnCount} with warnings, ${checkedCount - passedCount} with critical violations.`);

  if (hasCritical) {
    console.error('[schema-compat] Gate FAILED: one or more migrations contain backward-incompatible schema changes.');
    console.error('[schema-compat] Use expand-and-contract: add new columns with defaults before removing old ones.');
    process.exit(1);
  }

  console.log('[schema-compat] Gate PASSED: all migrations are backward-compatible and safe for zero-downtime rollout.');
  process.exit(0);
}

const results = scanMigrations(MIGRATIONS_DIR);
reportAndExit(results);
