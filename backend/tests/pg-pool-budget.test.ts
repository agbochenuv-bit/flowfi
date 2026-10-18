import { describe, it, expect } from 'vitest';
import { calculateConnectionBudget, createPgPoolConfig } from '../src/lib/pg-pool.js';

describe('PostgreSQL Connection Budget & Pool Sizing', () => {
  it('correctly calculates connection budgets across API and worker replicas', () => {
    const budget = calculateConnectionBudget({
      maxServerConnections: 100,
      reservedConnections: 10,
      apiReplicas: 3,
      workerReplicas: 2,
      apiWorkerSplitRatio: 0.7,
    });

    // Available: 100 - 10 = 90
    // API pool: floor(90 * 0.7) = 63 total -> 63 / 3 = 21 per replica
    // Worker pool: 90 - 63 = 27 total -> 27 / 2 = 13 per replica
    expect(budget.totalAvailable).toBe(90);
    expect(budget.apiPoolMax).toBe(21);
    expect(budget.workerPoolMax).toBe(13);
    // Total allocated = 21 * 3 + 13 * 2 = 63 + 26 = 89 <= 90
    expect(budget.totalAllocated).toBeLessThanOrEqual(90);
  });

  it('guarantees at least 1 connection per replica even under extreme constraints', () => {
    const budget = calculateConnectionBudget({
      maxServerConnections: 8,
      reservedConnections: 5,
      apiReplicas: 10,
      workerReplicas: 10,
    });

    expect(budget.apiPoolMax).toBeGreaterThanOrEqual(1);
    expect(budget.workerPoolMax).toBeGreaterThanOrEqual(1);
  });

  it('createPgPoolConfig respects default pool limits when replica env vars are absent', () => {
    const config = createPgPoolConfig();
    expect(config.max).toBeDefined();
    expect(config.max).toBeGreaterThan(0);
  });
});
