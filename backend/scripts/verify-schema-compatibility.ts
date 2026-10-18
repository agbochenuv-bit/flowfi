#!/usr/bin/env ts-node
import fs from 'node:fs';
import path from 'node:path';
import { verifySchemaMigrationCompatibility } from '../src/lib/schema-compatibility-gate.js';

/**
 * CLI release gate script to inspect all migration SQL files in backend/prisma/migrations
 */
export function scanMigrations(migrationsDir: string): boolean {
  if (!fs.existsSync(migrationsDir)) {
    console.error(`Migrations directory not found: ${migrationsDir}`);
    return false;
  }

  const entries = fs.readdirSync(migrationsDir, { withFileTypes: true });
  let hasCriticalViolations = false;

  for (const entry of entries) {
    if (entry.isDirectory()) {
      const sqlPath = path.join(migrationsDir, entry.name, 'migration.sql');
      if (fs.existsSync(sqlPath)) {
        const sql = fs.readFileSync(sqlPath, 'utf8');
        const result = verifySchemaMigrationCompatibility(sql);

        if (!result.safeForRollout) {
          console.error(`\n[GATE FAILURE] Incompatible migration detected in: ${entry.name}`);
          for (const violation of result.violations) {
            console.error(` - [${violation.severity}] ${violation.reason}`);
            console.error(`   SQL: ${violation.statement}`);
          }
          hasCriticalViolations = true;
        }
      }
    }
  }

  if (hasCriticalViolations) {
    console.error('\nRelease gate check FAILED: Migration contains backward-incompatible schema changes.');
    return false;
  }

  console.log('\nRelease gate check PASSED: All migrations are backward-compatible and safe for rollback.');
  return true;
}

if (process.argv[1] && process.argv[1].endsWith('verify-schema-compatibility.ts')) {
  const migrationsPath = path.join(__dirname, '../prisma/migrations');
  const success = scanMigrations(migrationsPath);
  process.exit(success ? 0 : 1);
}
