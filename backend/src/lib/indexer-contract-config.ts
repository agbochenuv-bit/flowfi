import { PrismaClient, Prisma } from '@prisma/client';

/**
 * Supported event schema versions for per-contract indexing configuration.
 * Bump this list when the shape of indexed events changes in a breaking way.
 */
export const SUPPORTED_EVENT_SCHEMA_VERSIONS = [1, 2] as const;
export type EventSchemaVersion = (typeof SUPPORTED_EVENT_SCHEMA_VERSIONS)[number];

/**
 * Per-contract indexing configuration.
 *
 * A single contract address may be indexed on multiple networks, and multiple
 * deployments (distinct addresses) may be indexed on the same network. Each
 * configuration is uniquely identified by the combination of
 * `contractAddress` + `networkPassphrase` (see {@link computeConfigKey}).
 */
export interface ContractIndexingConfig {
  /** Stellar contract address (C... StrKey, 56 chars). */
  contractAddress: string;
  /** Stellar network passphrase identifying the network. */
  networkPassphrase: string;
  /** Ledger to begin indexing from (inclusive). Must be >= 0. */
  startLedger: number;
  /** Version of the event schema this contract's events are decoded with. */
  eventSchemaVersion: EventSchemaVersion;
  /** Whether indexing is currently enabled for this configuration. */
  enabled: boolean;
}

/**
 * Error thrown when a contract indexing configuration is invalid.
 */
export class ContractConfigError extends Error {
  readonly field: string;

  constructor(message: string, field: string) {
    super(message);
    this.name = 'ContractConfigError';
    this.field = field;
    Object.setPrototypeOf(this, ContractConfigError.prototype);
  }
}

/**
 * Stellar contract address format: a `C` followed by 55 base32 characters
 * (total length 56). This mirrors the StrKey encoding for contract IDs.
 */
const CONTRACT_ADDRESS_REGEX = /^C[A-Z2-7]{55}$/;

/**
 * Validates a single contract indexing configuration.
 *
 * @throws {ContractConfigError} when any field is invalid.
 */
export function validateContractConfig(config: ContractIndexingConfig): void {
  if (!config || typeof config !== 'object') {
    throw new ContractConfigError('Configuration must be an object', 'config');
  }

  if (
    typeof config.contractAddress !== 'string' ||
    !CONTRACT_ADDRESS_REGEX.test(config.contractAddress)
  ) {
    throw new ContractConfigError(
      'contractAddress must be a valid Stellar contract address (C... StrKey, 56 chars)',
      'contractAddress',
    );
  }

  if (
    typeof config.networkPassphrase !== 'string' ||
    config.networkPassphrase.trim().length === 0
  ) {
    throw new ContractConfigError(
      'networkPassphrase must be a non-empty string',
      'networkPassphrase',
    );
  }

  if (
    typeof config.startLedger !== 'number' ||
    !Number.isInteger(config.startLedger) ||
    config.startLedger < 0
  ) {
    throw new ContractConfigError(
      'startLedger must be a non-negative integer',
      'startLedger',
    );
  }

  if (
    !SUPPORTED_EVENT_SCHEMA_VERSIONS.includes(
      config.eventSchemaVersion as EventSchemaVersion,
    )
  ) {
    throw new ContractConfigError(
      `eventSchemaVersion must be one of: ${SUPPORTED_EVENT_SCHEMA_VERSIONS.join(', ')}`,
      'eventSchemaVersion',
    );
  }

  if (typeof config.enabled !== 'boolean') {
    throw new ContractConfigError('enabled must be a boolean', 'enabled');
  }
}

/**
 * Computes a stable key for a configuration from its contract address and
 * network passphrase. This isolates cursors and event schemas per deployment
 * and per network, so the same address on different networks (or different
 * addresses on the same network) never collide.
 */
export function computeConfigKey(
  contractAddress: string,
  networkPassphrase: string,
): string {
  return `${networkPassphrase}::${contractAddress}`;
}

/**
 * Loads all enabled contract indexing configurations from Prisma.
 *
 * Invalid persisted rows are skipped (and reported via the optional logger)
 * rather than aborting the whole indexing run.
 */
export async function loadEnabledConfigs(
  prisma: PrismaClient,
  logger: Pick<Console, 'warn'> = console,
): Promise<ContractIndexingConfig[]> {
  const rows = await prisma.contractIndexingConfig.findMany({
    where: { enabled: true },
    orderBy: [{ networkPassphrase: 'asc' }, { contractAddress: 'asc' }],
  });

  const configs: ContractIndexingConfig[] = [];
  for (const row of rows) {
    const config: ContractIndexingConfig = {
      contractAddress: row.contractAddress,
      networkPassphrase: row.networkPassphrase,
      startLedger: row.startLedger,
      eventSchemaVersion: row.eventSchemaVersion as EventSchemaVersion,
      enabled: row.enabled,
    };
    try {
      validateContractConfig(config);
      configs.push(config);
    } catch (err) {
      if (err instanceof ContractConfigError) {
        logger.warn(
          `Skipping invalid contract indexing config (${computeConfigKey(
            row.contractAddress,
            row.networkPassphrase,
          )}): ${err.message}`,
        );
      } else {
        throw err;
      }
    }
  }

  return configs;
}

/**
 * Creates or updates a contract indexing configuration.
 *
 * @throws {ContractConfigError} when the configuration is invalid.
 */
export async function upsertConfig(
  prisma: PrismaClient,
  config: ContractIndexingConfig,
): Promise<ContractIndexingConfig> {
  validateContractConfig(config);

  const row = await prisma.contractIndexingConfig.upsert({
    where: {
      contractAddress_networkPassphrase: {
        contractAddress: config.contractAddress,
        networkPassphrase: config.networkPassphrase,
      },
    },
    create: {
      contractAddress: config.contractAddress,
      networkPassphrase: config.networkPassphrase,
      startLedger: config.startLedger,
      eventSchemaVersion: config.eventSchemaVersion,
      enabled: config.enabled,
    },
    update: {
      startLedger: config.startLedger,
      eventSchemaVersion: config.eventSchemaVersion,
      enabled: config.enabled,
    },
  });

  return {
    contractAddress: row.contractAddress,
    networkPassphrase: row.networkPassphrase,
    startLedger: row.startLedger,
    eventSchemaVersion: row.eventSchemaVersion as EventSchemaVersion,
    enabled: row.enabled,
  };
}

/**
 * Disables a contract indexing configuration without deleting it, preserving
 * its cursor for potential re-enablement.
 *
 * @throws {ContractConfigError} when the address or passphrase is invalid.
 */
export async function disableConfig(
  prisma: PrismaClient,
  contractAddress: string,
  networkPassphrase: string,
): Promise<void> {
  if (!CONTRACT_ADDRESS_REGEX.test(contractAddress)) {
    throw new ContractConfigError(
      'contractAddress must be a valid Stellar contract address (C... StrKey, 56 chars)',
      'contractAddress',
    );
  }
  if (typeof networkPassphrase !== 'string' || networkPassphrase.trim().length === 0) {
    throw new ContractConfigError(
      'networkPassphrase must be a non-empty string',
      'networkPassphrase',
    );
  }

  await prisma.contractIndexingConfig.update({
    where: {
      contractAddress_networkPassphrase: { contractAddress, networkPassphrase },
    },
    data: { enabled: false },
  });
}

/**
 * Per-config operator status: cursor position, lag, and network identity.
 */
export interface OperatorConfigStatus {
  configKey: string;
  contractAddress: string;
  networkPassphrase: string;
  enabled: boolean;
  eventSchemaVersion: EventSchemaVersion;
  startLedger: number;
  /** Last successfully indexed ledger, or null if none yet. */
  lastIndexedLedger: number | null;
  /** Latest ledger known on the network, or null if unknown. */
  latestLedger: number | null;
  /** Lag in ledgers (latestLedger - lastIndexedLedger), or null if unknown. */
  lag: number | null;
}

/**
 * Returns operator-facing status for every configured contract, including
 * cursor position, lag, and network identity. This lets operators inspect
 * two deployments on one network and the same address on separate networks.
 */
export async function getOperatorStatus(
  prisma: PrismaClient,
): Promise<OperatorConfigStatus[]> {
  const rows = await prisma.contractIndexingConfig.findMany({
    orderBy: [{ networkPassphrase: 'asc' }, { contractAddress: 'asc' }],
  });

  return rows.map((row) => {
    const lastIndexedLedger =
      typeof row.lastIndexedLedger === 'number' ? row.lastIndexedLedger : null;
    const latestLedger =
      typeof row.latestLedger === 'number' ? row.latestLedger : null;
    const lag =
      lastIndexedLedger !== null && latestLedger !== null
        ? Math.max(0, latestLedger - lastIndexedLedger)
        : null;

    return {
      configKey: computeConfigKey(row.contractAddress, row.networkPassphrase),
      contractAddress: row.contractAddress,
      networkPassphrase: row.networkPassphrase,
      enabled: row.enabled,
      eventSchemaVersion: row.eventSchemaVersion as EventSchemaVersion,
      startLedger: row.startLedger,
      lastIndexedLedger,
      latestLedger,
      lag,
    };
  });
}

export type { Prisma };