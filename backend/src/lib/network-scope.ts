import type { Request } from 'express';
import { getConfiguredStellarNetwork } from './stellar-network.js';

export type StellarNetwork = 'testnet' | 'mainnet';

/**
 * Header name callers use to declare the Stellar network a request is scoped to.
 */
export const NETWORK_HEADER = 'x-stellar-network';

/**
 * Query parameter name callers use to declare the Stellar network a request is
 * scoped to.
 */
export const NETWORK_QUERY = 'network';

const NETWORKS: Record<string, StellarNetwork> = {
  testnet: 'testnet',
  mainnet: 'mainnet',
  pubnet: 'mainnet',
};

/**
 * Normalize a raw network value into a canonical `StellarNetwork`, returning
 * `null` when the value is not a known Stellar network.
 */
export function normalizeNetwork(value: unknown): StellarNetwork | null {
  if (typeof value !== 'string') return null;
  const canonical = NETWORKS[value.toLowerCase()];
  return canonical ?? null;
}

/**
 * Resolve the network scope for a request.
 *
 * Resolution order:
 *  1. `X-Stellar-Network` request header
 *  2. `network` query parameter
 *  3. The server-configured network (unambiguous default)
 *
 * Returns `null` only when no header/query is present and the server has no
 * configured network, in which case the caller must treat the request as
 * unscoped rather than guess a network.
 */
export function resolveNetworkScope(req: Request): StellarNetwork | null {
  const header = normalizeNetwork(req.headers[NETWORK_HEADER]);
  if (header) return header;

  const query = normalizeNetwork((req.query as Record<string, string | string[] | undefined>)[NETWORK_QUERY]);
  if (query) return query;

  const configured = getConfiguredStellarNetwork();
  return configured;
}

/**
 * Assert that a request carries an unambiguous network scope. Throws an
 * `OrganizationNetworkError` (400) when the network cannot be determined so
 * callers never resolve an organization-scoped resource against the wrong
 * network.
 */
export function requireNetworkScope(req: Request): StellarNetwork {
  const network = resolveNetworkScope(req);
  if (!network) {
    throw new OrganizationNetworkError(
      'Stellar network scope is required. Send the X-Stellar-Network header or ?network query parameter.',
      400,
    );
  }
  return network;
}

/**
 * Error returned when a request targets an organization-scoped resource on a
 * network that does not match the resource's network.
 */
export class OrganizationNetworkError extends Error {
  public readonly statusCode: number;

  constructor(message = 'Network scope mismatch', statusCode = 400) {
    super(message);
    this.name = 'OrganizationNetworkError';
    this.statusCode = statusCode;
  }
}

/**
 * Assert that a resource's network matches the request's resolved network.
 * Throws `OrganizationNetworkError` (409) on mismatch so identical resource
 * identifiers on different networks cannot collide.
 */
export function assertResourceNetwork(
  resourceNetwork: StellarNetwork | string | null | undefined,
  requestNetwork: StellarNetwork,
): void {
  if (!resourceNetwork || String(resourceNetwork).toLowerCase() !== requestNetwork) {
    throw new OrganizationNetworkError(
      `Resource is not scoped to network "${requestNetwork}"`,
      409,
    );
  }
}
