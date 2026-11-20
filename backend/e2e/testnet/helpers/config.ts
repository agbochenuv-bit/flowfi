import { existsSync, readFileSync } from 'fs';
import { join } from 'path';

export type Network = 'testnet' | 'production';

export interface PartnerConfig {
  network: Network;
  apiBaseUrl: string;
  apiKey: string;
  apiSecret: string;
  webhookSecret: string;
  webhookUrl: string;
}

const REQUIRED_KEYS: Array<keyof PartnerConfig> = [
  'network',
  'apiBaseUrl',
  'apiKey',
  'apiSecret',
  'webhookSecret',
  'webhookUrl',
];

const TESTNET_HOST_MARKERS = ['testnet', 'sandbox', 'staging'];
const PRODUCTION_HOST_MARKERS = ['api.', 'prod'];

/**
 * Loads partner onboarding configuration from a JSON file.
 *
 * Partners must keep testnet and production credentials in separate files
 * (e.g. `partner.testnet.json` and `partner.production.json`). This helper
 * enforces that separation so a clean-environment validation cannot silently
 * run against the wrong network.
 */
export function loadPartnerConfig(path: string): PartnerConfig {
  if (!existsSync(path)) {
    throw new Error(`Partner config not found at ${path}`);
  }

  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    throw new Error(`Partner config at ${path} is not valid JSON: ${(err as Error).message}`);
  }

  if (typeof raw !== 'object' || raw === null) {
    throw new Error(`Partner config at ${path} must be a JSON object`);
  }

  const config = raw as Partial<PartnerConfig>;
  const missing = REQUIRED_KEYS.filter((key) => {
    const value = config[key];
    return value === undefined || value === null || String(value).trim() === '';
  });

  if (missing.length > 0) {
    throw new Error(`Partner config at ${path} is missing required keys: ${missing.join(', ')}`);
  }

  if (config.network !== 'testnet' && config.network !== 'production') {
    throw new Error(`Partner config at ${path} has invalid network "${config.network}" (expected testnet or production)`);
  }

  return config as PartnerConfig;
}

/**
 * Validates that the configured endpoint matches the declared network.
 * Prevents testnet credentials from being pointed at production endpoints
 * (and vice versa) during onboarding and go-live checks.
 */
export function assertNetworkMatchesEndpoint(config: PartnerConfig): void {
  const host = safeHost(config.apiBaseUrl);
  const lower = host.toLowerCase();

  if (config.network === 'testnet') {
    const looksProduction = PRODUCTION_HOST_MARKERS.some((marker) => lower.includes(marker));
    const looksTestnet = TESTNET_HOST_MARKERS.some((marker) => lower.includes(marker));
    if (looksProduction && !looksTestnet) {
      throw new Error(`Testnet config points at a production-looking endpoint: ${host}`);
    }
    return;
  }

  const looksTestnet = TESTNET_HOST_MARKERS.some((marker) => lower.includes(marker));
  if (looksTestnet) {
    throw new Error(`Production config points at a testnet-looking endpoint: ${host}`);
  }
}

/**
 * Ensures testnet and production configs never share secrets or endpoints.
 */
export function assertConfigsIsolated(testnet: PartnerConfig, production: PartnerConfig): void {
  if (testnet.network !== 'testnet' || production.network !== 'production') {
    throw new Error('assertConfigsIsolated expects a testnet config and a production config');
  }

  const shared: string[] = [];
  if (testnet.apiKey === production.apiKey) shared.push('apiKey');
  if (testnet.apiSecret === production.apiSecret) shared.push('apiSecret');
  if (testnet.webhookSecret === production.webhookSecret) shared.push('webhookSecret');
  if (testnet.apiBaseUrl === production.apiBaseUrl) shared.push('apiBaseUrl');

  if (shared.length > 0) {
    throw new Error(`Testnet and production configs must not share: ${shared.join(', ')}`);
  }
}

/**
 * Resolves the default config path for a network inside a given directory.
 */
export function defaultConfigPath(dir: string, network: Network): string {
  return join(dir, `partner.${network}.json`);
}

function safeHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    throw new Error(`Invalid apiBaseUrl: ${url}`);
  }
}
