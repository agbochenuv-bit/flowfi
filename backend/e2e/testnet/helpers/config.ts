import { Networks } from '@stellar/stellar-sdk';

/**
 * Runtime configuration for the Stellar Testnet E2E suite.
 * Every value can be overridden via env so the suite can also target a
 * local `stellar/quickstart` container or a futurenet deployment.
 */
export const testnetConfig = {
  rpcUrl: process.env.E2E_SOROBAN_RPC_URL ?? 'https://soroban-testnet.stellar.org',
  horizonUrl: process.env.E2E_HORIZON_URL ?? 'https://horizon-testnet.stellar.org',
  friendbotUrl: process.env.E2E_FRIENDBOT_URL ?? 'https://friendbot.stellar.org',
  networkPassphrase: process.env.E2E_NETWORK_PASSPHRASE ?? Networks.TESTNET,
  /** Deployed stream contract under test (C...). Required for contract/indexer suites. */
  contractId: process.env.E2E_STREAM_CONTRACT_ID ?? '',
  /** Upper bound on average ledger close time before we flag timing drift. */
  maxLedgerCloseSeconds: Number(process.env.E2E_MAX_LEDGER_CLOSE_SECONDS ?? '15'),
  /** Max time to wait for a submitted transaction to reach a final status. */
  txTimeoutMs: Number(process.env.E2E_TX_TIMEOUT_MS ?? '90000'),
  /** Max time to wait for the indexer to ingest on-chain events into Postgres. */
  indexerTimeoutMs: Number(process.env.E2E_INDEXER_TIMEOUT_MS ?? '120000'),
};

/**
 * Deterministic local Soroban fixture configuration.
 *
 * Points the suite at a local `stellar/quickstart` container (or any
 * self-hosted Soroban RPC) so stream creation and lifecycle calls can be
 * exercised without depending on public testnet availability. The contract
 * artifact is pinned via `E2E_LOCAL_CONTRACT_WASM` so every case runs against
 * the exact same bytecode; state is reset between cases by the fixture
 * harness (see `backend/e2e/testnet/README.md`).
 */
export const localFixtureConfig = {
  rpcUrl: process.env.E2E_LOCAL_RPC_URL ?? 'http://localhost:8000/soroban/rpc',
  horizonUrl: process.env.E2E_LOCAL_HORIZON_URL ?? 'http://localhost:8000',
  friendbotUrl: process.env.E2E_LOCAL_FRIENDBOT_URL ?? 'http://localhost:8000/friendbot',
  networkPassphrase: process.env.E2E_LOCAL_NETWORK_PASSPHRASE ?? Networks.STANDALONE,
  /** Path to the pinned stream contract WASM artifact installed by the fixture. */
  contractWasmPath: process.env.E2E_LOCAL_CONTRACT_WASM ?? 'target/wasm32-unknown-unknown/release/stream_contract.wasm',
  /** Deterministic contract id (C...) the fixture deploys the pinned artifact to. */
  contractId: process.env.E2E_LOCAL_STREAM_CONTRACT_ID ?? '',
  /** Max time to wait for a submitted transaction to reach a final status. */
  txTimeoutMs: Number(process.env.E2E_LOCAL_TX_TIMEOUT_MS ?? '30000'),
  /** Max time to wait for the indexer to ingest on-chain events into Postgres. */
  indexerTimeoutMs: Number(process.env.E2E_LOCAL_INDEXER_TIMEOUT_MS ?? '30000'),
};

export function hasContract(): boolean {
  return testnetConfig.contractId.length > 0;
}

export function hasDatabase(): boolean {
  return Boolean(process.env.DATABASE_URL);
}

/** True when the local fixture is configured with a deployed contract id. */
export function hasLocalContract(): boolean {
  return localFixtureConfig.contractId.length > 0;
}

/**
 * Selects the active fixture config. Defaults to the public testnet config so
 * existing suites keep their behavior; set `E2E_FIXTURE=local` to run against
 * the deterministic local fixture instead.
 */
export function activeFixtureConfig() {
  return process.env.E2E_FIXTURE === 'local' ? localFixtureConfig : testnetConfig;
}
