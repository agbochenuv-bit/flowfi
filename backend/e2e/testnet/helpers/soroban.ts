import {
  Asset,
  BASE_FEE,
  Contract,
  Keypair,
  TransactionBuilder,
  rpc,
  scValToNative,
  type xdr,
} from '@stellar/stellar-sdk';
import { testnetConfig } from './config.js';

export const server = new rpc.Server(testnetConfig.rpcUrl, {
  allowHttp: testnetConfig.rpcUrl.startsWith('http://'),
});

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Retry `fn` with exponential backoff; used for flaky public endpoints. */
export async function withRetry<T>(
  label: string,
  fn: () => Promise<T>,
  { attempts = 5, baseMs = 1_000 } = {},
): Promise<T> {
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (i < attempts - 1) await sleep(baseMs * 2 ** i);
    }
  }
  throw new Error(
    `${label} failed after ${attempts} attempts: ${lastErr instanceof Error ? lastErr.message : String(lastErr)}`,
  );
}

/** Poll `check` until it returns a non-undefined value or the timeout elapses. */
export async function waitFor<T>(
  label: string,
  check: () => Promise<T | undefined>,
  { timeoutMs, intervalMs = 2_000 }: { timeoutMs: number; intervalMs?: number },
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await check();
    if (value !== undefined) return value;
    await sleep(intervalMs);
  }
  throw new Error(`Timed out after ${timeoutMs}ms waiting for: ${label}`);
}

/** Fund a fresh account via Friendbot and return its keypair. */
export async function createFundedAccount(): Promise<Keypair> {
  const kp = Keypair.random();
  await withRetry('Friendbot funding', async () => {
    const res = await fetch(
      `${testnetConfig.friendbotUrl}?addr=${encodeURIComponent(kp.publicKey())}`,
    );
    // Friendbot returns 400 "createAccountAlreadyExist" on a retry after a
    // successful-but-timed-out first attempt; treat that as success.
    if (!res.ok) {
      const body = await res.text();
      if (!body.includes('createAccountAlreadyExist')) {
        throw new Error(`Friendbot HTTP ${res.status}: ${body.slice(0, 300)}`);
      }
    }
  });
  // Wait until the RPC node can see the new account (ledger ingestion lag).
  await waitFor(
    `account ${kp.publicKey()} visible on RPC`,
    async () => {
      try {
        return await server.getAccount(kp.publicKey());
      } catch {
        return undefined;
      }
    },
    { timeoutMs: 60_000 },
  );
  return kp;
}

/** Stellar Asset Contract address for native XLM on the configured network. */
export function nativeTokenContractId(): string {
  return Asset.native().contractId(testnetConfig.networkPassphrase);
}

/**
 * A single network's deployment identifiers. `contracts` maps a logical
 * contract name (e.g. "escrow") to its on-chain contract ID.
 */
export interface NetworkEntry {
  networkPassphrase: string;
  rpcUrl: string;
  friendbotUrl?: string;
  contracts: Record<string, string>;
}

/**
 * Versioned registry of supported networks. Bump `version` whenever any
 * entry changes so operators can detect drift against their pinned values.
 */
export interface NetworkRegistry {
  version: number;
  networks: Record<string, NetworkEntry>;
}

/**
 * Trust/update policy: the registry below is the source of truth shipped with
 * the SDK. Operators pin approved values via `pinRegistry`; runtime resolution
 * (`resolveNetwork`) then uses the pinned entries and rejects any entry whose
 * passphrase or contract identity differs from the pin. To adopt a new
 * registry version, review the diff, bump the pin, and re-run the e2e suite.
 */
export const NETWORK_REGISTRY: NetworkRegistry = {
  version: 1,
  networks: {
    testnet: {
      networkPassphrase: testnetConfig.networkPassphrase,
      rpcUrl: testnetConfig.rpcUrl,
      friendbotUrl: testnetConfig.friendbotUrl,
      contracts: {},
    },
  },
};

const CONTRACT_ID_RE = /^C[A-Z2-7]{55}$/;

/** Validate a single registry entry; throws on malformed passphrase/contracts. */
export function validateNetworkEntry(name: string, entry: NetworkEntry): void {
  if (!entry.networkPassphrase || entry.networkPassphrase.trim().length === 0) {
    throw new Error(`registry entry "${name}": missing network passphrase`);
  }
  if (!entry.rpcUrl || !/^https?:\/\//.test(entry.rpcUrl)) {
    throw new Error(`registry entry "${name}": invalid rpcUrl "${entry.rpcUrl}"`);
  }
  for (const [contractName, contractId] of Object.entries(entry.contracts)) {
    if (!CONTRACT_ID_RE.test(contractId)) {
      throw new Error(
        `registry entry "${name}": contract "${contractName}" has invalid contract ID "${contractId}"`,
      );
    }
  }
}

/** Validate every entry in a registry; throws on the first invalid entry. */
export function validateRegistry(registry: NetworkRegistry): void {
  if (!Number.isInteger(registry.version) || registry.version < 1) {
    throw new Error(`registry: invalid version ${registry.version}`);
  }
  for (const [name, entry] of Object.entries(registry.networks)) {
    validateNetworkEntry(name, entry);
  }
}

/**
 * Pin approved registry values. The pinned registry is validated up front and
 * used by `resolveNetwork` instead of the shipped defaults.
 */
export function pinRegistry(registry: NetworkRegistry): NetworkRegistry {
  validateRegistry(registry);
  return registry;
}

/**
 * Resolve a network from the registry, optionally against a pinned registry.
 * Rejects unknown networks and any entry whose passphrase or contract identity
 * changed relative to the pin.
 */
export function resolveNetwork(
  name: string,
  pinned?: NetworkRegistry,
  registry: NetworkRegistry = NETWORK_REGISTRY,
): NetworkEntry {
  const source = pinned ?? registry;
  const entry = source.networks[name];
  if (!entry) {
    throw new Error(`unknown network "${name}" in registry v${source.version}`);
  }
  validateNetworkEntry(name, entry);

  if (pinned) {
    const current = registry.networks[name];
    if (!current) {
      throw new Error(`network "${name}" removed from registry v${registry.version}`);
    }
    if (current.networkPassphrase !== entry.networkPassphrase) {
      throw new Error(`network "${name}": passphrase changed since pin`);
    }
    const pinnedContracts = entry.contracts;
    const currentContracts = current.contracts;
    for (const [contractName, contractId] of Object.entries(pinnedContracts)) {
      if (currentContracts[contractName] !== contractId) {
        throw new Error(
          `network "${name}": contract "${contractName}" changed since pin`,
        );
      }
    }
  }

  return entry;
}

export interface InvokeResult {
  hash: string;
  ledger: number;
  returnValue: unknown;
}

/**
 * Build, simulate, sign, submit and await a Soroban contract invocation.
 * Throws with the full result XDR on simulation or execution failure so the
 * CI log pinpoints protocol/RPC regressions.
 */
export async function invokeContract(
  signer: Keypair,
  contractId: string,
  method: string,
  args: xdr.ScVal[],
): Promise<InvokeResult> {
  const source = await server.getAccount(signer.publicKey());
  const tx = new TransactionBuilder(source, {
    fee: BASE_FEE,
    networkPassphrase: testnetConfig.networkPassphrase,
  })
    .addOperation(new Contract(contractId).call(method, ...args))
    .setTimeout(60)
    .build();

  // prepareTransaction simulates, applies the footprint/resource fee and auth.
  const prepared = await server.prepareTransaction(tx);
  prepared.sign(signer);

  const sent = await server.sendTransaction(prepared);
  if (sent.status === 'ERROR' || sent.status === 'TRY_AGAIN_LATER') {
    throw new Error(
      `${method}: sendTransaction returned ${sent.status}: ${sent.errorResult?.toXDR('base64') ?? 'no errorResult'}`,
    );
  }

  const final = await waitFor(
    `${method} tx ${sent.hash} to finalize`,
    async () => {
      const res = await server.getTransaction(sent.hash);
      return res.status === rpc.Api.GetTransactionStatus.NOT_FOUND ? undefined : res;
    },
    { timeoutMs: testnetConfig.txTimeoutMs, intervalMs: 1_500 },
  );

  if (final.status !== rpc.Api.GetTransactionStatus.SUCCESS) {
    throw new Error(
      `${method}: transaction ${sent.hash} ${final.status}: ${final.resultXdr?.toXDR('base64') ?? ''}`,
    );
  }

  return {
    hash: sent.hash,
    ledger: final.ledger,
    returnValue: final.returnValue ? scValToNative(final.returnValue) : undefined,
  };
}

/** Read-only contract call via simulation (no submission, no fees). */
export async function simulateRead(
  source: Keypair,
  contractId: string,
  method: string,
  args: xdr.ScVal[],
): Promise<unknown> {
  const account = await server.getAccount(source.publicKey());
  const tx = new TransactionBuilder(account, {
    fee: BASE_FEE,
    networkPassphrase: testnetConfig.networkPassphrase,
  })
    .addOperation(new Contract(contractId).call(method, ...args))
    .setTimeout(30)
    .build();
  const sim = await server.simulateTransaction(tx);
  if (rpc.Api.isSimulationError(sim)) {
    throw new Error(`${method} simulation failed: ${sim.error}`);
  }
  const retval = sim.result?.retval;
  return retval ? scValToNative(retval) : undefined;
}
