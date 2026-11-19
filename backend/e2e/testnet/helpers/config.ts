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

export function hasContract(): boolean {
  return testnetConfig.contractId.length > 0;
}

export function hasDatabase(): boolean {
  return Boolean(process.env.DATABASE_URL);
}

/**
 * Deployment manifest describing a single contract/application release.
 * A manifest must be reviewed and machine-validated before a version is
 * promoted between testnet and production environments.
 */
export interface DeploymentManifest {
  /** Target network the release is promoted to (e.g. "testnet", "public"). */
  network: string;
  /** Stellar network passphrase the target network expects. */
  networkPassphrase: string;
  /** Deployed contract ID (C...) the release points at. */
  contractId: string;
  /** SHA-256 digest of the built artifact (wasm/binary). */
  artifactDigest: string;
  /** Schema version the release expects to be compatible with. */
  schemaVersion: number;
}

/**
 * Expected values a manifest is validated against. Supplied by the promotion
 * pipeline (target environment config) so mismatches are rejected up front.
 */
export interface ManifestExpectation {
  network: string;
  networkPassphrase: string;
  contractId: string;
  artifactDigest: string;
  /** Highest schema version the target environment can consume. */
  maxSchemaVersion: number;
}

const CONTRACT_ID_PATTERN = /^C[A-Z2-7]{55}$/;
const DIGEST_PATTERN = /^[0-9a-f]{64}$/;

export interface ManifestValidationResult {
  ok: boolean;
  errors: string[];
}

/**
 * Validate a deployment manifest against the target environment before
 * promotion. Checks network, contract ID, artifact digest, and schema
 * compatibility. Returns every failure so reviewers see the full picture.
 */
export function validateDeploymentManifest(
  manifest: DeploymentManifest,
  expected: ManifestExpectation,
): ManifestValidationResult {
  const errors: string[] = [];

  if (manifest.network !== expected.network) {
    errors.push(`network mismatch: manifest "${manifest.network}" != expected "${expected.network}"`);
  }

  if (manifest.networkPassphrase !== expected.networkPassphrase) {
    errors.push('network passphrase mismatch');
  }

  if (!CONTRACT_ID_PATTERN.test(manifest.contractId)) {
    errors.push(`invalid contract ID format: "${manifest.contractId}"`);
  } else if (manifest.contractId !== expected.contractId) {
    errors.push(`contract ID mismatch: manifest "${manifest.contractId}" != expected "${expected.contractId}"`);
  }

  if (!DIGEST_PATTERN.test(manifest.artifactDigest)) {
    errors.push(`invalid artifact digest format: "${manifest.artifactDigest}"`);
  } else if (manifest.artifactDigest !== expected.artifactDigest) {
    errors.push('artifact digest mismatch');
  }

  if (!Number.isInteger(manifest.schemaVersion) || manifest.schemaVersion < 1) {
    errors.push(`invalid schema version: ${manifest.schemaVersion}`);
  } else if (manifest.schemaVersion > expected.maxSchemaVersion) {
    errors.push(
      `incompatible schema version: manifest ${manifest.schemaVersion} > supported ${expected.maxSchemaVersion}`,
    );
  }

  return { ok: errors.length === 0, errors };
}

/**
 * Gate a promotion on a validated manifest. Throws with the aggregated
 * validation errors when the manifest is rejected so the pipeline halts
 * before any network change is applied.
 */
export function assertPromotionAllowed(
  manifest: DeploymentManifest,
  expected: ManifestExpectation,
): void {
  const result = validateDeploymentManifest(manifest, expected);
  if (!result.ok) {
    throw new Error(`deployment manifest rejected:\n- ${result.errors.join('\n- ')}`);
  }
}
