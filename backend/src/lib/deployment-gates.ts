/**
 * Deployment Health Gates and Rollback Evaluator
 *
 * Implements automated validation of health gates across:
 * - Backend container liveness & readiness
 * - Database migration backward-compatibility
 * - Frontend asset/CSP health
 * - Contract immutability / rollback decision boundaries
 */

export interface HealthGateMetrics {
  backendReady: boolean;
  dbPoolWaitTimeMs: number;
  indexerLagLedgers: number;
  httpErrorRatePercent: number;
  schemaCompatibleWithPreviousVersion: boolean;
  isOnChainContractRelease: boolean;
}

export type RollbackActionType =
  | 'NO_ACTION'
  | 'REVERSIBLE_APP_ROLLBACK'
  | 'EMERGENCY_ONCHAIN_PAUSE'
  | 'FORWARD_FIX_REQUIRED';

export interface GateEvaluationResult {
  passed: boolean;
  gateFailures: string[];
  recommendedAction: RollbackActionType;
  rationale: string;
}

export function evaluateDeploymentGates(metrics: HealthGateMetrics): GateEvaluationResult {
  const failures: string[] = [];

  if (!metrics.backendReady) {
    failures.push('Gate 2 Failure: Backend readiness check failed');
  }

  if (metrics.dbPoolWaitTimeMs > 50) {
    failures.push(`Gate 2 Failure: DB pool wait time too high (${metrics.dbPoolWaitTimeMs}ms > 50ms)`);
  }

  if (metrics.indexerLagLedgers > 5) {
    failures.push(`Gate 3 Failure: Indexer lag exceeds threshold (${metrics.indexerLagLedgers} ledgers > 5)`);
  }

  if (metrics.httpErrorRatePercent > 1.0) {
    failures.push(`Gate 2 Failure: HTTP error rate exceeds threshold (${metrics.httpErrorRatePercent}% > 1.0%)`);
  }

  if (!metrics.schemaCompatibleWithPreviousVersion) {
    failures.push('Gate 1 Failure: Target database schema is incompatible with previous backend version');
  }

  if (failures.length === 0) {
    return {
      passed: true,
      gateFailures: [],
      recommendedAction: 'NO_ACTION',
      rationale: 'All deployment health gates passed successfully. Traffic shift approved.',
    };
  }

  // Rollback decision logic: distinguish reversible off-chain rollbacks from irreversible on-chain actions
  if (metrics.isOnChainContractRelease) {
    return {
      passed: false,
      gateFailures: failures,
      recommendedAction: 'EMERGENCY_ONCHAIN_PAUSE',
      rationale:
        'On-chain contracts cannot be reverted via container rollback. Recommend executing emergency contract pause and deploying forward fix.',
    };
  }

  if (!metrics.schemaCompatibleWithPreviousVersion) {
    return {
      passed: false,
      gateFailures: failures,
      recommendedAction: 'FORWARD_FIX_REQUIRED',
      rationale:
        'Schema is not backward-compatible with previous backend version. Rolling back application pods would break database queries. Apply forward corrective migration.',
    };
  }

  return {
    passed: false,
    gateFailures: failures,
    recommendedAction: 'REVERSIBLE_APP_ROLLBACK',
    rationale:
      'Off-chain application failure with backward-compatible schema. Instantly revert application pods to previous stable image digest.',
  };
}
