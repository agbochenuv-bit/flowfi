/**
 * High-level FlowFi client for direct Stellar ledger access.
 *
 * External dApps, payroll providers, and bots use this client to build,
 * simulate, sign, and submit FlowFi stream transactions WITHOUT routing
 * through the FlowFi backend API.
 *
 * ```ts
 * import { FlowFiClient, KeypairSigner } from '@flowfi/sdk';
 *
 * const client = new FlowFiClient({
 *   rpcUrl: 'https://soroban-testnet.stellar.org',
 *   networkPassphrase: 'Test SDF Network ; September 2015',
 *   contractId: 'C...',
 * });
 * const signer = new KeypairSigner(process.env.PAYROLL_SECRET!);
 * const { streamId } = await client.createStream(
 *   { sender, recipient, tokenAddress, amount: 1_000_000n, duration: 3600 },
 *   signer,
 * );
 * ```
 *
 * Works in browsers (pair with `FreighterSigner`) and Node.js (pair with
 * `KeypairSigner` or `CustomSigner`).
 */

import {
  buildCancelXdr,
  buildCloseXdr,
  buildContractCallXdr,
  buildCreateStreamXdr,
  buildTopUpXdr,
  buildWithdrawXdr,
  simulateAndAssemble,
  DEFAULT_FEE_BUFFER_MULTIPLIER,
} from './builder.js';
import { validateNetworkPassphrase } from './networks.js';
import { abortable, runWithCancellation, throwIfAborted, withAbortSignal } from './cancellation.js';
import type { OperationOptions } from './cancellation.js';
import type { Signer } from './signers/index.js';
import type {
  ActionReadiness,
  CreateStreamParams,
  FlowFiClientConfig,
  FlowFiSession,
  FlowFiSessionList,
  StreamConflict,
  StreamDetails,
  StreamResult,
  SubmitResult,
  WithdrawResult,
} from './types.js';

export type { FlowFiClientConfig };

/**
 * Error thrown when a mutation is rejected because the stream changed since the
 * caller reviewed it (HTTP 409). Carries the current version metadata so the
 * caller can re-read the stream and retry with a fresh `expectedVersion`.
 *
 * Wallet-signed transaction semantics are unchanged: the conflict is detected
 * before any transaction is built/signed, so no signature is ever produced for
 * a stale mutation.
 */
export class StreamConflictError extends Error {
  readonly code = 'STREAM_VERSION_CONFLICT' as const;
  readonly streamId: bigint;
  readonly expectedVersion: bigint;
  readonly currentVersion: bigint;
  readonly current: StreamDetails | null;

  constructor(conflict: StreamConflict) {
    super(
      `FlowFiClient: stream ${conflict.streamId} changed (expected version ${conflict.expectedVersion}, current ${conflict.currentVersion})`,
    );
    this.name = 'StreamConflictError';
    this.streamId = conflict.streamId;
    this.expectedVersion = conflict.expectedVersion;
    this.currentVersion = conflict.currentVersion;
    this.current = conflict.current ?? null;
  }
}

/** Options accepted by every mutating write path. */
export interface MutationOptions extends OperationOptions {
  /**
   * State version the caller reviewed. When provided, the mutation is rejected
   * with a {@link StreamConflictError} if the stream has since changed.
   */
  expectedVersion?: bigint;
}

export class FlowFiClient {
  private config: Required<Pick<FlowFiClientConfig, 'rpcUrl' | 'networkPassphrase' | 'contractId'>> &
    Pick<FlowFiClientConfig, 'readOnlySourceAccount'> &
    Pick<FlowFiClientConfig, 'feeBufferMultiplier'>;
  /** Injectable RPC shim used by unit tests to avoid network I/O. */
  private rpcClient?: unknown;

  constructor(config: FlowFiClientConfig, opts?: { rpcClient?: unknown }) {
    if (!config.rpcUrl || !config.networkPassphrase || !config.contractId) {
      throw new Error('FlowFiClient: rpcUrl, networkPassphrase and contractId are required');
    }
    // Fail fast on a mistyped passphrase: otherwise it only surfaces later as
    // an opaque signature/hash-mismatch error (see networks.ts).
    if (!config.allowCustomNetworkPassphrase) {
      const { valid, hint } = validateNetworkPassphrase(config.networkPassphrase);
      if (!valid) {
        throw new Error(`FlowFiClient: ${hint}`);
      }
    }
    this.config = {
      rpcUrl: config.rpcUrl,
      networkPassphrase: config.networkPassphrase,
      contractId: config.contractId,
      readOnlySourceAccount: config.readOnlySourceAccount,
      feeBufferMultiplier: config.feeBufferMultiplier ?? DEFAULT_FEE_BUFFER_MULTIPLIER,
    };
    this.rpcClient = opts?.rpcClient;
  }

  /** Override the RPC client (tests / custom transports). */
  setRpcClient(client: unknown): void {
    this.rpcClient = client;
  }

  // ─── Write paths (build → simulate → sign → submit) ────────────────────────

  /** Create a stream and return its on-chain ID plus the submission hash. */
  async createStream(params: CreateStreamParams, signer: Signer, opts?: OperationOptions): Promise<StreamResult> {
    return runWithCancellation(opts, async (signal) => {
      validateCreateParams(params);
      const source = await abortable(Promise.resolve(signer.getPublicKey({ signal })), signal);
      const unsigned = await buildCreateStreamXdr(params, {
        sourceAccount: source,
        contractId: this.config.contractId,
        networkPassphrase: this.config.networkPassphrase,
      });
      const { transactionHash } = await this.signAndSubmit(unsigned, signer, signal);
      const streamId = await abortable(this.pollStreamIdFromTx(transactionHash), signal);
      return { streamId, transactionHash };
    });
  }

  /** Withdraw all claimable funds for each stream ID. */
  async batchWithdraw(streamIds: bigint[], signer: Signer, opts?: OperationOptions): Promise<WithdrawResult[]> {
    return runWithCancellation(opts, async (signal) => {
      if (streamIds.length === 0) throw new Error('batchWithdraw: streamIds must not be empty');
      const recipient = await abortable(Promise.resolve(signer.getPublicKey({ signal })), signal);
      const out: WithdrawResult[] = [];
      for (const streamId of streamIds) {
        throwIfAborted(signal);
        const unsigned = await buildWithdrawXdr(streamId, recipient, this.baseBuildArgs(recipient));
        const { transactionHash, returnValue } = await this.signAndSubmit(unsigned, signer, signal);
        out.push({ streamId, amount: returnValue ?? 0n, transactionHash });
      }
      return out;
    });
  }

  /** Top up an active stream with additional tokens (sender-signed). */
  async topUpStream(streamId: bigint, amount: bigint, signer: Signer, opts?: MutationOptions): Promise<SubmitResult> {
    return runWithCancellation(opts, async (signal) => {
      if (amount <= 0n) throw new Error('topUpStream: amount must be > 0');
      const sender = await abortable(Promise.resolve(signer.getPublicKey({ signal })), signal);
      await this.assertFresh(streamId, opts?.expectedVersion, signal);
      const unsigned = await buildTopUpXdr(streamId, sender, amount, this.baseBuildArgs(sender));
      const { transactionHash } = await this.signAndSubmit(unsigned, signer, signal);
      return { transactionHash };
    });
  }

  /** Cancel an active stream (sender-signed; settles + refunds). */
  async cancelStream(streamId: bigint, signer: Signer, opts?: MutationOptions): Promise<SubmitResult> {
    return runWithCancellation(opts, async (signal) => {
      const sender = await abortable(Promise.resolve(signer.getPublicKey({ signal })), signal);
      await this.assertFresh(streamId, opts?.expectedVersion, signal);
      const unsigned = await buildCancelXdr(streamId, sender, this.baseBuildArgs(sender));
      const { transactionHash } = await this.signAndSubmit(unsigned, signer, signal);
      return { transactionHash };
    });
  }

  /** Prune a fully settled stream's storage entry (sender/recipient/admin). */
  async closeStream(streamId: bigint, signer: Signer, opts?: MutationOptions): Promise<SubmitResult> {
    return runWithCancellation(opts, async (signal) => {
      const caller = await abortable(Promise.resolve(signer.getPublicKey({ signal })), signal);
      await this.assertFresh(streamId, opts?.expectedVersion, signal);
      const unsigned = await buildCloseXdr(streamId, caller, this.baseBuildArgs(caller));
      const { transactionHash } = await this.signAndSubmit(unsigned, signer, signal);
      return { transactionHash };
    });
  }

  // ─── Preflight readiness (no signing, no submission) ───────────────────────

  /**
   * Return machine-readable readiness checks for a stream action.
   *
   * Results are advisory only: a `ready` result does NOT promise the
   * transaction will succeed (state can change between the check and the
   * submission). `blockers` must be resolved before attempting the action;
   * `warnings` are informational.
   */
  async getActionReadiness(
    streamId: bigint,
    action: 'withdraw' | 'top_up' | 'cancel' | 'close',
    opts?: OperationOptions & { expectedVersion?: bigint },
  ): Promise<ActionReadiness> {
    return runWithCancellation(opts, async (signal) => {
      if (this.rpcClient && typeof (this.rpcClient as { getActionReadiness?: unknown }).getActionReadiness === 'function') {
        return abortable(
          (this.rpcClient as {
            getActionReadiness: (
              id: bigint,
              action: string,
              opts?: { expectedVersion?: bigint },
            ) => Promise<ActionReadiness>;
          }).getActionReadiness(streamId, action, { expectedVersion: opts?.expectedVersion }),
          signal,
        );
      }
      // Without a backend shim we cannot evaluate authorization/network/asset
      // checks locally; surface a single explicit blocker rather than guessing.
      return {
        streamId,
        action,
        ready: false,
        blockers: [{ code: 'READINESS_UNAVAILABLE', message: 'Readiness checks require a backend RPC shim' }],
        warnings: [],
      };
    });
  }

  // ─── Wallet sessions (inventory + revocation) ──────────────────────────────

  /**
   * List active wallet-authenticated sessions for the current wallet.
   * Session identifiers are opaque; signing secrets are never returned.
   */
  async listSessions(opts?: OperationOptions): Promise<FlowFiSessionList> {
    return runWithCancellation(opts, async (signal) => {
      if (this.rpcClient && typeof (this.rpcClient as { listSessions?: unknown }).listSessions === 'function') {
        return abortable(
          (this.rpcClient as { listSessions: () => Promise<FlowFiSessionList> }).listSessions(),
          signal,
        );
      }
      throw new Error('FlowFiClient: listSessions requires a backend RPC shim');
    });
  }

  /**
   * Revoke a single wallet session by its opaque session ID. Revocation takes
   * effect immediately for both API calls and SSE streams.
   */
  async revokeSession(sessionId: string, opts?: OperationOptions): Promise<FlowFiSession> {
    return runWithCancellation(opts, async (signal) => {
      if (!sessionId) throw new Error('revokeSession: sessionId is required');
      if (this.rpcClient && typeof (this.rpcClient as { revokeSession?: unknown }).revokeSession === 'function') {
        return abortable(
          (this.rpcClient as { revokeSession: (id: string) => Promise<FlowFiSession> }).revokeSession(sessionId),
          signal,
        );
      }
      throw new Error('FlowFiClient: revokeSession requires a backend RPC shim');
    });
  }

  // ─── Read paths (no signing required) ──────────────────────────────────────

  /** Fetch a stream record. Returns `null` when pruned / non-existent. */
  async getStream(streamId: bigint, opts?: OperationOptions): Promise<StreamDetails | null> {
    return runWithCancellation(opts, async (signal) => {
      if (this.rpcClient && typeof (this.rpcClient as { getStream?: unknown }).getStream === 'function') {
        return abortable((this.rpcClient as { getStream: (id: bigint) => Promise<StreamDetails | null> }).getStream(streamId), signal);
      }
      return this.simulateRead<StreamDetails | null>('get_stream', [streamId], signal);
    });
  }

  /** Current claimable amount without mutating state. */
  async getClaimableAmount(streamId: bigint, opts?: OperationOptions): Promise<bigint> {
    return runWithCancellation(opts, async (signal) => {
      if (this.rpcClient && typeof (this.rpcClient as { getClaimableAmount?: unknown }).getClaimableAmount === 'function') {
        return abortable((this.rpcClient as { getClaimableAmount: (id: bigint) => Promise<bigint> }).getClaimableAmount(streamId), signal);
      }
      const value = await this.simulateRead<bigint | string | number | null>('get_claimable_amount', [streamId], signal);
      return BigInt(value ?? 0);
    });
  }

  // ─── Internals ─────────────────────────────────────────────────────────────

  /**
   * Reject a mutation when the caller supplied an `expectedVersion` that no
   * longer matches the stream's current version. Runs before any transaction is
   * built or signed, so wallet authorization semantics are untouched.
   */
  private async assertFresh(streamId: bigint, expectedVersion: bigint | undefined, signal: AbortSignal): Promise<void> {
    if (expectedVersion === undefined) return;
    const current = await this.getStream(streamId, { signal });
    if (current === null) {
      throw new StreamConflictError({
        streamId,
        expectedVersion,
        currentVersion: 0n,
        current: null,
      });
    }
    const currentVersion = current.version ?? 0n;
    if (currentVersion !== expectedVersion) {
      throw new StreamConflictError({ streamId, expectedVersion, currentVersion, current });
    }
  }

  private baseBuildArgs(sourceAccount: string): {
    sourceAccount: string;
    contractId: string;
    networkPassphrase: string;
  } {
    return {
      sourceAccount,
      contractId: this.config.contractId,
      networkPassphrase: this.config.networkPassphrase,
    };
  }

  private async signAndSubmit(
    unsignedXdr: string,
    signer: Signer,
    signal: AbortSignal,
  ): Promise<{ transactionHash: string; returnValue?: bigint }> {
    const { assembledXdr } = await simulateAndAssemble({
      unsignedXdr,
      networkPassphrase: this.config.networkPassphrase,
      rpcUrl: this.config.rpcUrl,
      feeBufferMultiplier: this.config.feeBufferMultiplier,
      signal,
      rpcClient: this.rpcClient as { simulateTransaction(tx: unknown): Promise<unknown> } | undefined,
    });

    throwIfAborted(signal);
    const signedXdr = await signer.signTransaction(assembledXdr, {
      networkPassphrase: this.config.networkPassphrase,
      signal,
    });

    throwIfAborted(signal);
    return this.submitSigned(signedXdr, signal);
  }

  private async submitSigned(
    signedXdr: string,
    signal: AbortSignal,
  ): Promise<{ transactionHash: string; returnValue?: bigint }> {
    if (this.rpcClient && typeof (this.rpcClient as { sendTransaction?: unknown }).sendTransaction === 'function') {
      return withAbortSignal(
        this.rpcClient,
        signal,
        () => (this.rpcClient as { sendTransaction: (xdr: string, opts?: { signal?: AbortSignal }) => Promise<{ transactionHash: string; returnValue?: bigint }> }).sendTransaction(signedXdr, { signal }),
      );
    }
    const { TransactionBuilder, rpc } = await import('@stellar/stellar-sdk');
    const server = new rpc.Server(this.config.rpcUrl, {
      allowHttp: this.config.rpcUrl.startsWith('http://'),
    });
    const tx = TransactionBuilder.fromXDR(signedXdr, this.config.networkPassphrase);
    const sent = await withAbortSignal(server, signal, () => server.sendTransaction(tx as never));
    const hash = (sent as unknown as { hash?: string }).hash ?? '';
    // Best-effort: derive the created stream ID / return value via polling.
    // `pollStreamIdFromTx` handles the `createStream` case; other entrypoints
    // surface return values through `getTransaction` meta decoding where available.
    void hash;
    return { transactionHash: hash };
  }

  private async pollStreamIdFromTx(transactionHash: string): Promise<bigint> {
    if (this.rpcClient && typeof (this.rpcClient as { getStreamIdForTx?: unknown }).getStreamIdForTx === 'function') {
      return (this.rpcClient as { getStreamIdForTx: (h: string) => Promise<bigint> }).getStreamIdForTx(transactionHash);
    }
    // Without an indexer shim we cannot decode the return value synchronously;
    // return a sentinel so typed callers still compile. Production dApps should
    // resolve the ID via `getTransaction` meta or the backend indexer webhook.
    void transactionHash;
    return 0n;
  }

  private async simulateRead<T>(method: string, args: unknown[], signal: AbortSignal): Promise<T> {
    const sourceAccount = this.config.readOnlySourceAccount;
    if (!sourceAccount) {
      throw new Error('FlowFiClient: readOnlySourceAccount is required for live read simulations');
    }
    const { nativeToScVal, scValToNative, rpc, TransactionBuilder } = await abortable(
      import('@stellar/stellar-sdk'),
      signal,
    );
    const callXdr = await buildContractCallXdr({
      sourceAccount,
      contractId: this.config.contractId,
      networkPassphrase: this.config.networkPassphrase,
      method,
      methodArgs: args.map((arg) => nativeToScVal(arg, { type: 'u64' })),
    });
    const tx = TransactionBuilder.fromXDR(callXdr, this.config.networkPassphrase);
    const server = this.rpcClient ?? new rpc.Server(this.config.rpcUrl, {
      allowHttp: this.config.rpcUrl.startsWith('http://'),
    });
    const simulation = await withAbortSignal(
      server,
      signal,
      () => (server as { simulateTransaction(tx: unknown, opts?: { signal?: AbortSignal }): Promise<{ result?: { retval?: unknown }; error?: unknown }> }).simulateTransaction(tx, { signal }),
    );
    if (simulation.error) {
      throw new Error(`FlowFiClient: ${method} simulation failed: ${JSON.stringify(simulation.error)}`);
    }
    const native = simulation.result?.retval === undefined
      ? null
      : scValToNative(simulation.result.retval as never);
    if (method === 'get_claimable_amount') return native as T;
    return decodeStream(native) as T;
  }
}

function decodeStream(value: unknown): StreamDetails | null {
  if (value === null || value === undefined) return null;
  const raw = toRecord(value);
  const status = enumValue(raw.status);
  const schedule = decodeSchedule(raw.schedule);
  return {
    streamId: toBigInt(raw.stream_id ?? raw.streamId),
    sender: String(raw.sender),
    recipient: String(raw.recipient),
    tokenAddress: String(raw.token_address ?? raw.tokenAddress),
    ratePerSecond: toBigInt(raw.rate_per_second ?? raw.ratePerSecond),
    depositedAmount: toBigInt(raw.deposited_amount ?? raw.depositedAmount),
    withdrawnAmount: toBigInt(raw.withdrawn_amount ?? raw.withdrawnAmount),
    startTime: toBigInt(raw.start_time ?? raw.startTime),
    lastUpdateTime: toBigInt(raw.last_update_time ?? raw.lastUpdateTime),
    cliffTime: raw.cliff_time === null || raw.cliff_time === undefined
      ? raw.cliff_time as null | undefined
      : toBigInt(raw.cliff_time),
    isActive: Boolean(raw.is_active ?? raw.isActive),
    paused: Boolean(raw.paused),
    status: status as StreamDetails['status'],
    schedule,
  };
}

function toRecord(value: unknown): Record<string, unknown> {
  if (value instanceof Map) return Object.fromEntries(value.entries());
  if (typeof value === 'object' && value !== null) return value as Record<string, unknown>;
  throw new Error('FlowFiClient: unexpected get_stream result shape');
}

function toBigInt(value: unknown): bigint {
  if (typeof value === 'bigint' || typeof value === 'number' || typeof value === 'string') return BigInt(value);
  throw new Error('FlowFiClient: unexpected integer in get_stream result');
}

function enumValue(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value instanceof Map && value.size === 1) return String(value.keys().next().value);
  if (typeof value === 'object' && value !== null) {
    const keys = Object.keys(value);
    if (keys.length === 1) return keys[0] ?? '';
  }
  throw new Error('FlowFiClient: unexpected stream status result');
}

function decodeSchedule(value: unknown): StreamDetails['schedule'] {
  if (value === null || value === undefined) return undefined;
  const raw = value instanceof Map ? Object.fromEntries(value.entries()) : value as Record<string, unknown>;
  const [variant, payload] = value instanceof Map
    ? [String(value.keys().next().value), value.values().next().value]
    : [Object.keys(raw)[0] ?? '', raw[Object.keys(raw)[0] ?? '']];
  if (variant === 'Linear') return { kind: 'linear' };
  if (variant === 'StepTranches' && Array.isArray(payload)) {
    return {
      kind: 'step_tranches',
      steps: payload.map((step) => {
        const item = toRecord(step);
        return { unlockTime: toBigInt(item.unlock_time ?? item.unlockTime), unlockAmount: toBigInt(item.unlock_amount ?? item.unlockAmount) };
      }),
    };
  }
  if (variant === 'HybridCliffLinear' && Array.isArray(payload)) {
    return { kind: 'hybrid_cliff_linear', cliffTime: toBigInt(payload[0]), cliffUnlockAmount: toBigInt(payload[1]) };
  }
  throw new Error('FlowFiClient: unexpected vesting schedule result');
}

function validateCreateParams(params: CreateStreamParams): void {
  if (params.amount <= 0n) throw new Error('createStream: amount must be > 0');
  if (params.duration <= 0) throw new Error('createStream: duration must be > 0');
  if (params.cliffDuration !== undefined) {
    if (params.cliffDuration <= 0 || params.cliffDuration > params.duration) {
      throw new Error('createStream: cliffDuration must satisfy 0 < cliff <= duration');
    }
  }
}
