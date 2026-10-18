/**
 * Database Schema Compatibility Release Gate
 *
 * Verifies that pending database schema migrations adhere to expand-and-contract
 * principles, ensuring:
 * 1. The new backend version can operate against both current and target schemas.
 * 2. The previous backend version can continue serving traffic during the rollout window.
 * 3. Rollback of application code remains safe without schema rollback or data loss.
 */

export interface MigrationRuleViolation {
  statement: string;
  reason: string;
  severity: 'CRITICAL' | 'WARNING';
}

export interface CompatibilityCheckResult {
  safeForRollout: boolean;
  canRollbackApp: boolean;
  violations: MigrationRuleViolation[];
  summary: string;
}

const DESTRUCTIVE_RULES = [
  {
    pattern: /DROP\s+TABLE/i,
    reason: 'Dropping a table breaks backward-compatibility with running application replicas.',
    severity: 'CRITICAL' as const,
  },
  {
    pattern: /ALTER\s+TABLE\s+.*DROP\s+COLUMN/i,
    reason: 'Dropping a column immediately breaks older application pods that still query this column.',
    severity: 'CRITICAL' as const,
  },
  {
    pattern: /ALTER\s+TABLE\s+.*RENAME\s+COLUMN/i,
    reason: 'Renaming a column breaks existing queries. Instead, add a new column and duplicate writes.',
    severity: 'CRITICAL' as const,
  },
  {
    pattern: /ALTER\s+TABLE\s+.*RENAME\s+TO/i,
    reason: 'Renaming a table breaks running services. Create a view or migrate under an abstraction.',
    severity: 'CRITICAL' as const,
  },
  {
    // Adding a NOT NULL column without a DEFAULT value will cause inserts from older code to fail
    pattern: /ADD\s+COLUMN\s+.*NOT\s+NULL(?!\s+DEFAULT)/i,
    reason: 'Adding a NOT NULL column without a DEFAULT value causes existing application inserts to fail.',
    severity: 'CRITICAL' as const,
  },
  {
    // Non-concurrent index creation on high-volume tables can lock the table
    pattern: /CREATE\s+INDEX(?!\s+CONCURRENTLY)/i,
    reason: 'Index creation should use CONCURRENTLY in production to avoid locking active tables.',
    severity: 'WARNING' as const,
  },
];

/**
 * Validates migration SQL script statements against expand-and-contract safety rules.
 */
export function verifySchemaMigrationCompatibility(migrationSql: string): CompatibilityCheckResult {
  const statements = migrationSql
    .split(';')
    .map((s) => s.trim())
    .filter((s) => s.length > 0 && !s.startsWith('--'));

  const violations: MigrationRuleViolation[] = [];

  for (const statement of statements) {
    for (const rule of DESTRUCTIVE_RULES) {
      if (rule.pattern.test(statement)) {
        violations.push({
          statement,
          reason: rule.reason,
          severity: rule.severity,
        });
      }
    }
  }

  const criticalCount = violations.filter((v) => v.severity === 'CRITICAL').length;
  const safeForRollout = criticalCount === 0;
  const canRollbackApp = safeForRollout;

  let summary: string;
  if (safeForRollout) {
    summary = 'Schema migration passes backward-compatibility gates. Application rollback is supported.';
  } else {
    summary = `Schema migration violates expand-and-contract policy (${criticalCount} critical violation(s)). Rollout blocked.`;
  }

  return {
    safeForRollout,
    canRollbackApp,
    violations,
    summary,
  };
}
