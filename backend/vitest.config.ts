import { defineConfig } from 'vitest/config';

export default defineConfig({
    test: {
        environment: 'node',
        globals: true,
        setupFiles: [],
        // Provide a stable JWT_SECRET so verifyJwt is deterministic in tests.
        // Challenge TTL / audience / network env vars keep wallet-challenge
        // tests deterministic across the forks pool.
        env: {
          JWT_SECRET: 'flowfi-test-secret-do-not-use-in-production',
          WALLET_CHALLENGE_TTL_SECONDS: '300',
          WALLET_CHALLENGE_AUDIENCE: 'flowfi-test',
          WALLET_CHALLENGE_NETWORK: 'testnet',
          // OpenAPI parity tests read the committed spec from this path.
          OPENAPI_SPEC_PATH: 'swagger/flowfi.openapi.json',
        },
        include: ['tests/**/*.{test,spec}.ts'],
        coverage: {
            enabled: true,
            provider: 'v8',
            reportsDirectory: './coverage',
            reporter: ['text', 'json', 'html', 'lcov'],
            exclude: [
                'node_modules/**',
                'dist/**',
                'src/generated/**',
                '**/*.test.ts',
                '**/*.spec.ts',
                'prisma/**',
                'src/index.ts',
                'src/lib/prisma-sandbox.ts',
                'src/services/indexer-integration.example.ts',
                'src/services/indexer.service.ts',
                'src/services/sorobanService.ts',
                'src/workers/soroban-event-worker.ts',
            ],
            // Restore thresholds to 60% as targeted in the coverage improvement task.
            thresholds: {
                statements: 60,
                branches: 60,
                functions: 60,
                lines: 60,
            },
        },
        testTimeout: 30000,
        hookTimeout: 30000,
        // Run each test file in its own forked process so vi.mock() doesn't leak
        pool: 'forks',
        isolate: true,
    },
});
