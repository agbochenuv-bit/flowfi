import { describe, it, expect } from 'vitest';
import {
  evaluateDeploymentGates,
  HealthGateMetrics,
} from '../src/lib/deployment-gates.js';

describe('Deployment Health Gates and Rollback Evaluator', () => {
  const healthyBaseline: HealthGateMetrics = {
    backendReady: true,
    dbPoolWaitTimeMs: 12,
    indexerLagLedgers: 1,
    httpErrorRatePercent: 0.05,
    schemaCompatibleWithPreviousVersion: true,
    isOnChainContractRelease: false,
  };

  it('approves traffic shift when all health gates pass', () => {
    const result = evaluateDeploymentGates(healthyBaseline);
    expect(result.passed).toBe(true);
    expect(result.recommendedAction).toBe('NO_ACTION');
    expect(result.gateFailures).toHaveLength(0);
  });

  it('triggers reversible application rollback when container readiness fails on backward-compatible schema', () => {
    const result = evaluateDeploymentGates({
      ...healthyBaseline,
      backendReady: false,
    });

    expect(result.passed).toBe(false);
    expect(result.recommendedAction).toBe('REVERSIBLE_APP_ROLLBACK');
    expect(result.gateFailures[0]).toContain('Backend readiness check failed');
  });

  it('recommends emergency on-chain pause for contract release failures', () => {
    const result = evaluateDeploymentGates({
      ...healthyBaseline,
      isOnChainContractRelease: true,
      httpErrorRatePercent: 2.5,
    });

    expect(result.passed).toBe(false);
    expect(result.recommendedAction).toBe('EMERGENCY_ONCHAIN_PAUSE');
    expect(result.rationale).toContain('On-chain contracts cannot be reverted via container rollback');
  });

  it('flags forward-fix required when database schema is incompatible with previous version', () => {
    const result = evaluateDeploymentGates({
      ...healthyBaseline,
      schemaCompatibleWithPreviousVersion: false,
    });

    expect(result.passed).toBe(false);
    expect(result.recommendedAction).toBe('FORWARD_FIX_REQUIRED');
  });

  it('detects indexer lag violations', () => {
    const result = evaluateDeploymentGates({
      ...healthyBaseline,
      indexerLagLedgers: 12,
    });

    expect(result.passed).toBe(false);
    expect(result.gateFailures.some((f) => f.includes('Indexer lag exceeds threshold'))).toBe(true);
  });
});
