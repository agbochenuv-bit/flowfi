export type StellarNetworkId = "testnet" | "mainnet";

/** The indexer and signing services are configured for one network per deployment. */
export function getConfiguredStellarNetwork(): StellarNetworkId {
  return process.env.STELLAR_NETWORK === "mainnet" ? "mainnet" : "testnet";
}

export function isConfiguredStellarNetwork(value: unknown): value is StellarNetworkId {
  return value === getConfiguredStellarNetwork();
}