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
 * Known network passphrases keyed by the canonical network name used in the
 * deployment decision guide. Used to verify that the configured RPC endpoint,
 * contract id, and passphrase all belong to the same network before a run.
 */
export const KNOWN_NETWORK_PASSPHRASES: Record<string, string> = {
  testnet: Networks.TESTNET,
  futurenet: Networks.FUTURENET,
  public: Networks.PUBLIC,
  standalone: Networks.STANDALONE,
};

/**
 * A contract id is a StrKey-encoded contract address: `C` followed by 55
 * base32 characters. Anything else is a misconfiguration, not a valid target.
 */
export function isValidContractId(contractId: string): boolean {
  return /^C[A-Z2-7]{55}$/.test(contractId);
}

/**
 * Resolve the canonical network name from the configured passphrase.
 * Returns `undefined` when the passphrase does not match a known network,
 * which callers should treat as a hard configuration failure.
 */
export function resolveNetworkName(passphrase: string): string | undefined {
  return Object.keys(KNOWN_NETWORK_PASSPHRASES).find(
    (name) => KNOWN_NETWORK_PASSPHRASES[name] === passphrase,
  );
}

export interface PreflightResult {
  ok: boolean;
  errors: string[];
}

/**
 * Preflight check mirroring the deployment decision guide: verify that the
 * network passphrase is known, the RPC/Horizon endpoints are well-formed URLs,
 * and (when a contract is configured) that the contract id is valid. This
 * catches mismatched network/contract/endpoint combinations before a run
 * instead of failing mid-suite.
 */
export function preflight(
  config: {
    rpcUrl: string;
    horizonUrl: string;
    networkPassphrase: string;
    contractId: string;
  } = testnetConfig,
): PreflightResult {
  const errors: string[] = [];

  if (!resolveNetworkName(config.networkPassphrase)) {
    errors.push(
      `Unknown network passphrase: ${JSON.stringify(config.networkPassphrase)}. ` +
        'Expected one of testnet, futurenet, public, or standalone.',
    );
  }

  for (const [label, url] of [
    ['E2E_SOROBAN_RPC_URL', config.rpcUrl],
    ['E2E_HORIZON_URL', config.horizonUrl],
  ] as const) {
    try {
      const parsed = new URL(url);
      if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
        errors.push(`${label} must be an http(s) URL, got ${JSON.stringify(url)}.`);
      }
    } catch {
      errors.push(`${label} is not a valid URL: ${JSON.stringify(url)}.`);
    }
  }

  if (config.contractId.length > 0 && !isValidContractId(config.contractId)) {
    errors.push(
      `E2E_STREAM_CONTRACT_ID is not a valid contract id: ${JSON.stringify(config.contractId)}.`,
    );
  }

  return { ok: errors.length === 0, errors };
}
