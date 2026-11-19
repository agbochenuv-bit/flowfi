import { Networks } from '@stellar/stellar-sdk';

/**
 * A single network entry in the versioned configuration registry.
 * `contractId` is the deployed stream contract (C...) for that network and
 * `networkPassphrase` is the passphrase used to sign/verify transactions.
 */
export interface NetworkRegistryEntry {
  /** Human-readable network key (e.g. `testnet`, `futurenet`, `local`). */
  name: string;
  rpcUrl: string;
  horizonUrl: string;
  friendbotUrl: string;
  networkPassphrase: string;
  /** Deployed stream contract under test (C...). Empty when not yet deployed. */
  contractId: string;
}

/**
 * Versioned registry of supported network endpoints and deployment identifiers.
 * Bump `version` whenever any entry changes so operators can detect drift
 * against their pinned values.
 */
export const NETWORK_REGISTRY = {
  version: 1,
  networks: {
    testnet: {
      name: 'testnet',
      rpcUrl: 'https://soroban-testnet.stellar.org',
      horizonUrl: 'https://horizon-testnet.stellar.org',
      friendbotUrl: 'https://friendbot.stellar.org',
      networkPassphrase: Networks.TESTNET,
      contractId: '',
    },
    futurenet: {
      name: 'futurenet',
      rpcUrl: 'https://rpc-futurenet.stellar.org',
      horizonUrl: 'https://horizon-futurenet.stellar.org',
      friendbotUrl: 'https://friendbot-futurenet.stellar.org',
      networkPassphrase: Networks.FUTURENET,
      contractId: '',
    },
    local: {
      name: 'local',
      rpcUrl: 'http://localhost:8000/soroban/rpc',
      horizonUrl: 'http://localhost:8000',
      friendbotUrl: 'http://localhost:8000/friendbot',
      networkPassphrase: 'Standalone Network ; February 2017',
      contractId: '',
    },
  } as Record<string, NetworkRegistryEntry>,
} as const;

export type NetworkName = keyof typeof NETWORK_REGISTRY.networks;

/**
 * Operator-pinned registry values. When set, runtime resolution uses these
 * approved entries instead of the defaults above. Pins are keyed by network
 * name and may override any subset of fields.
 */
export type NetworkPins = Partial<Record<string, Partial<NetworkRegistryEntry>>>;

/**
 * Parse operator pins from `E2E_NETWORK_PINS` (JSON object keyed by network
 * name). Returns an empty object when unset or malformed.
 */
export function parseNetworkPins(raw: string | undefined): NetworkPins {
  if (!raw || raw.trim().length === 0) return {};
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as NetworkPins;
    }
  } catch {
    // Fall through to empty pins; malformed pins never silently override defaults.
  }
  return {};
}

/**
 * Resolve a network entry, applying operator pins on top of registry defaults.
 * Throws when the network is unknown or when a pinned entry fails validation.
 */
export function resolveNetwork(
  name: string,
  pins: NetworkPins = parseNetworkPins(process.env.E2E_NETWORK_PINS),
): NetworkRegistryEntry {
  const base = NETWORK_REGISTRY.networks[name];
  if (!base) {
    throw new Error(`Unknown network "${name}" in registry v${NETWORK_REGISTRY.version}`);
  }
  const pinned = pins[name];
  const resolved: NetworkRegistryEntry = { ...base, ...(pinned ?? {}) };
  validateNetworkEntry(resolved, name);
  return resolved;
}

/**
 * Validate passphrase and contract identity for a registry entry. Rejects
 * empty passphrases and malformed contract IDs (must be a C... StrKey).
 */
export function validateNetworkEntry(entry: NetworkRegistryEntry, name: string): void {
  if (!entry.networkPassphrase || entry.networkPassphrase.trim().length === 0) {
    throw new Error(`Network "${name}" has an empty network passphrase`);
  }
  if (entry.contractId.length > 0 && !/^C[A-Z2-7]{55}$/.test(entry.contractId)) {
    throw new Error(`Network "${name}" has an invalid contract ID: ${entry.contractId}`);
  }
}

/**
 * Detect drift between a pinned entry and the registry default. Returns the
 * list of fields whose pinned value differs from the registry value.
 */
export function detectRegistryDrift(
  name: string,
  pins: NetworkPins = parseNetworkPins(process.env.E2E_NETWORK_PINS),
): string[] {
  const base = NETWORK_REGISTRY.networks[name];
  const pinned = pins[name];
  if (!base || !pinned) return [];
  return (Object.keys(pinned) as (keyof NetworkRegistryEntry)[]).filter(
    (key) => pinned[key] !== undefined && pinned[key] !== base[key],
  );
}

const activeNetwork = process.env.E2E_NETWORK ?? 'testnet';
const activeEntry = resolveNetwork(activeNetwork);

/**
 * Runtime configuration for the Stellar Testnet E2E suite.
 * Every value can be overridden via env so the suite can also target a
 * local `stellar/quickstart` container or a futurenet deployment.
 */
export const testnetConfig = {
  rpcUrl: process.env.E2E_SOROBAN_RPC_URL ?? activeEntry.rpcUrl,
  horizonUrl: process.env.E2E_HORIZON_URL ?? activeEntry.horizonUrl,
  friendbotUrl: process.env.E2E_FRIENDBOT_URL ?? activeEntry.friendbotUrl,
  networkPassphrase: process.env.E2E_NETWORK_PASSPHRASE ?? activeEntry.networkPassphrase,
  /** Deployed stream contract under test (C...). Required for contract/indexer suites. */
  contractId: process.env.E2E_STREAM_CONTRACT_ID ?? activeEntry.contractId,
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
