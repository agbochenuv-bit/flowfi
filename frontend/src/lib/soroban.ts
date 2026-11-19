import type { WalletSession } from "@/lib/wallet";
import { getNetworkConfig, type NetworkId } from "@/lib/stellar-config";
import { formatAmount, parseAmountExact } from "@/utils/amount";

function activeNetworkConfig() {
  const stored = typeof window === "undefined" ? null : window.localStorage.getItem("flowfi.network");
  const id: NetworkId = stored === "mainnet" || stored === "futurenet" || stored === "sandbox" ? stored : "testnet";
  return getNetworkConfig(id);
}

export interface CreateStreamParams {
  recipient: string;
  tokenAddress: string;
  amount: bigint;
  durationSeconds: bigint;
}

export interface TopUpParams {
  streamId: bigint;
  amount: bigint;
}

export interface CancelParams {
  streamId: bigint;
}

export interface WithdrawParams {
  streamId: bigint;
}

export interface BatchWithdrawParams {
  streamIds: bigint[];
}

export interface PauseParams {
  streamId: bigint;
}

export interface ResumeParams {
  streamId: bigint;
}

export interface SorobanResult {
  success: true;
  txHash: string;
}

export type TransactionStage =
  | "simulating"
  | "awaiting_approval"
  | "submitted"
  | "confirming";

export type SimulationStatus = "success" | "failed" | "unavailable";

export type CongestionLevel = "low" | "moderate" | "high" | "unknown";

/**
 * A pre-signing cost estimate. `available: false` means the RPC could not be
 * reached or returned an unusable response — callers must show this explicitly
 * rather than falling back to a guessed fee.
 */
export interface TransactionCostEstimate {
  available: boolean;
  /** Total fee in stroops (base fee + resource fee), when available. */
  feeStroops: bigint | null;
  /** Total fee in XLM as a display string, when available. */
  feeXlm: string | null;
  simulationStatus: SimulationStatus;
  congestionLevel: CongestionLevel;
  /** Epoch ms when the estimate was fetched. */
  fetchedAt: number;
  /** True when the estimate is older than the staleness threshold. */
  stale: boolean;
  /** Human-readable reason when `available` is false. */
  unavailableReason?: string;
}

/** Estimates older than this are flagged stale and should be refreshed. */
export const FEE_ESTIMATE_STALE_MS = 30_000;

const STROOPS_PER_XLM = 10_000_000n;

export function isEstimateStale(
  fetchedAt: number,
  now: number = Date.now(),
  thresholdMs: number = FEE_ESTIMATE_STALE_MS,
): boolean {
  if (!Number.isFinite(fetchedAt) || fetchedAt <= 0) return true;
  return now - fetchedAt > thresholdMs;
}

function unavailableEstimate(
  reason: string,
  simulationStatus: SimulationStatus = "unavailable",
  fetchedAt: number = Date.now(),
): TransactionCostEstimate {
  return {
    available: false,
    feeStroops: null,
    feeXlm: null,
    simulationStatus,
    congestionLevel: "unknown",
    fetchedAt,
    stale: false,
    unavailableReason: reason,
  };
}

function toBigIntFee(value: unknown): bigint | null {
  if (typeof value === "bigint") return value >= 0n ? value : null;
  if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
    return BigInt(Math.trunc(value));
  }
  if (typeof value === "string" && /^\d+$/.test(value)) return BigInt(value);
  return null;
}

function formatStroopsAsXlm(stroops: bigint): string {
  const whole = stroops / STROOPS_PER_XLM;
  const frac = (stroops % STROOPS_PER_XLM).toString().padStart(7, "0").replace(/0+$/, "");
  return frac.length > 0 ? `${whole}.${frac}` : whole.toString();
}

/**
 * Maps a fee level (in stroops) to a coarse congestion bucket. Thresholds are
 * deliberately wide to avoid implying false precision.
 */
export function congestionFromFee(feeStroops: bigint | null): CongestionLevel {
  if (feeStroops === null) return "unknown";
  if (feeStroops <= 1_000n) return "low";
  if (feeStroops <= 10_000n) return "moderate";
  return "high";
}

export interface TransactionCostEstimateParams {
  /** The unsigned transaction to simulate (built by the caller). */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  transaction: any;
  /** Override the staleness threshold (ms). */
  staleThresholdMs?: number;
}

/**
 * Fetches the current fee estimate and simulation status for a prepared
 * transaction. Never throws: RPC failures produce an explicit unavailable
 * result so the UI can label the data instead of guessing.
 */
export async function getTransactionCostEstimate(
  params: TransactionCostEstimateParams,
): Promise<TransactionCostEstimate> {
  const fetchedAt = Date.now();
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const sdk: any = await import("@stellar/stellar-sdk");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const rpc: any = sdk.rpc ?? sdk.SorobanRpc;

    const config = activeNetworkConfig();
    const server = new rpc.Server(config.rpcUrl, { allowHttp: config.id === "sandbox" });

    const simResult = await server.simulateTransaction(params.transaction);
    const isError = rpc.Api?.isSimulationError?.(simResult) ?? Boolean(simResult?.error);

    if (isError) {
      const message: string =
        typeof simResult?.error === "string" ? simResult.error : (simResult?.error?.message ?? "unknown error");
      return {
        ...unavailableEstimate(`Simulation failed: ${message}`, "failed", fetchedAt),
        stale: isEstimateStale(fetchedAt, Date.now(), params.staleThresholdMs),
      };
    }

    const minResourceFee = toBigIntFee(simResult?.minResourceFee);
    const baseFee = toBigIntFee(simResult?.transactionData?.resourceFee);
    const feeStroops = minResourceFee ?? baseFee;

    if (feeStroops === null) {
      return {
        ...unavailableEstimate("Fee estimate was not returned by the network.", "success", fetchedAt),
        stale: isEstimateStale(fetchedAt, Date.now(), params.staleThresholdMs),
      };
    }

    return {
      available: true,
      feeStroops,
      feeXlm: formatStroopsAsXlm(feeStroops),
      simulationStatus: "success",
      congestionLevel: congestionFromFee(feeStroops),
      fetchedAt,
      stale: isEstimateStale(fetchedAt, Date.now(), params.staleThresholdMs),
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "RPC unavailable";
    return {
      ...unavailableEstimate(`Unable to fetch fee estimate: ${message}`, "unavailable", fetchedAt),
      stale: isEstimateStale(fetchedAt, Date.now(), params.staleThresholdMs),
    };
  }
}

export type TransactionStageCallback = (
  stage: TransactionStage,
  txHash?: string,
) => void;

export class SorobanCallError extends Error {
  constructor(
    message: string,
    public readonly code?:
      | "InvalidAmount"
      | "StreamNotFound"
      | "Unauthorized"
      | "StreamInactive"
      | "AlreadyInitialized"
      | "NotAdmin"
      | "InvalidFeeRate"
      | "NotInitialized"
      | "WalletRejected"
      | "TransactionTimeout"
      | "NetworkError"
      | "ContractNotFound"
      | "Unknown",
  ) {
    super(message);
    this.name = "SorobanCallError";
  }
}

const CONTRACT_NOT_FOUND_PATTERN =
  /(contract.*(not exist|not found|does not exist))|(missingvalue)|(no contract (code|instance) for)/i;

/**
 * Detects the specific Soroban RPC response shape that indicates there is no
 * contract deployed at the configured address, as opposed to a generic
 * simulation/network failure.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function isContractNotFoundError(simResult: any): boolean {
  const message: string =
    typeof simResult?.error === "string"
      ? simResult.error
      : (simResult?.error?.message ?? "");
  return CONTRACT_NOT_FOUND_PATTERN.test(message);
}

function contractNotFoundError(contractAddress: string): SorobanCallError {
  return new SorobanCallError(
    `No contract is deployed at address ${contractAddress} on this network. Check that NEXT_PUBLIC_STREAM_CONTRACT_ID (or the relevant token address) is configured correctly for this environment.`,
    "ContractNotFound",
  );
}

export type DurationUnit = "seconds" | "minutes" | "hours" | "days" | "weeks" | "months";

export const SECONDS_PER_UNIT: Record<DurationUnit, bigint> = {
  seconds: BigInt(1),
  minutes: BigInt(60),
  hours:   BigInt(3600),
  days:    BigInt(86400),
  weeks:   BigInt(604800),
  months:  BigInt(2592000),
};

export function toDurationSeconds(value: string, unit: DurationUnit): bigint {
  const parsed = parseFloat(value);
  if (isNaN(parsed) || parsed <= 0) {
    throw new SorobanCallError("Duration must be a positive number.", "InvalidAmount");
  }
  return BigInt(Math.round(parsed)) * SECONDS_PER_UNIT[unit];
}

export function toBaseUnits(value: string, decimals = 7): bigint {
  try {
    const amount = parseAmountExact(value, decimals);
    if (amount <= 0n) {
      throw new Error("Amount must be a positive number.");
    }
    return amount;
  } catch (error) {
    if (error instanceof RangeError) throw error;
    throw new SorobanCallError("Amount must be a positive number.", "InvalidAmount");
  }
}

export function fromBaseUnits(value: bigint | string, decimals = 7): string {
  const units = typeof value === "bigint" ? value : BigInt(value);
  return formatAmount(units, decimals);
}

export const TOKEN_ADDRESSES = {
  USDC: process.env.NEXT_PUBLIC_USDC_ADDRESS  ?? "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA",
  XLM:  process.env.NEXT_PUBLIC_XLM_ADDRESS   ?? "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCN",
  EURC: process.env.NEXT_PUBLIC_EURC_ADDRESS  ?? "CCWAMYJME4YOIUNAKVYEBYOG5I65QMKEX2NMN4OJAPXRPIF24ONPSHY",
} as const;

export function getTokenAddress(symbol: string): string {
  const address = (TOKEN_ADDRESSES as Record<string, string>)[symbol.toUpperCase()];
  if (!address) {
    throw new SorobanCallError(`Unsupported token: ${symbol}`, "Unknown");
  }
  return address;
}

export async function fetchTokenBalance(
  publicKey: string,
  tokenSymbol: string,
): Promise<bigint> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const sdk: any = await import("@stellar/stellar-sdk");
  const { Address, Contract, TransactionBuilder, BASE_FEE, scValToNative } = sdk;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const rpc: any = sdk.rpc ?? sdk.SorobanRpc;

  const tokenAddress = getTokenAddress(tokenSymbol);
  const config = activeNetworkConfig();
  const server = new rpc.Server(config.rpcUrl, { allowHttp: config.id === "sandbox" });
  const account = await server.getAccount(publicKey);
  const tokenContract = new Contract(tokenAddress);

  const tx = new TransactionBuilder(account, {
    fee: BASE_FEE,
    networkPassphrase: config.passphrase,
  })
    .addOperation(tokenContract.call("balance", new Address(publicKey).toScVal()))
    .setTimeout(30)
    .build();

  const simResult = await server.simulateTransaction(tx);
  if (rpc.Api?.isSimulationError?.(simResult) ?? simResult?.error) {
    if (isContractNotFoundError(simResult)) {
      throw contractNotFoundError(tokenAddress);
    }
    throw new SorobanCallError(`Failed to fetch token balance: ${simResult.error}`, "NetworkError");
  }

  const rawResult = simResult?.result?.retval;
  if (!rawResult) {
    throw new SorobanCallError("Token balance query returned no value.", "NetworkError");
  }

  const nativeValue = scValToNative(rawResult);
  if (typeof nativeValue === "bigint") {
    return nativeValue;
  }
  if (typeof nativeValue === "number") {
    return BigInt(Math.trunc(nativeValue));
  }
  if (typeof nativeValue === "string") {
    return BigInt(nativeValue);
  }

  throw new SorobanCallError("Token balance query returned an invalid value.", "NetworkError");
}

export async function fetchTokenBalanceDisplay(
  publicKey: string,
  tokenSymbol: string,
  decimals = 7,
): Promise<string> {
  const rawBalance = await fetchTokenBalance(publicKey, tokenSymbol);
  return fromBaseUnits(rawBalance, decimals);
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}



async function freighterCall(
  publicKey: string,
  method: string,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  args: any[],
  onStage?: TransactionStageCallback,
): Promise<SorobanResult> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const sdk: any = await import("@stellar/stellar-sdk");
  const { Contract, TransactionBuilder, BASE_FEE } = sdk;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const rpc: any = sdk.rpc ?? sdk.SorobanRpc;

  const { signTransaction } = await import("@stellar/freighter-api");

  const config = activeNetworkConfig();
  const server = new rpc.Server(config.rpcUrl, { allowHttp: config.id === "sandbox" });
  const account = await server.getAccount(publicKey);
  const contract = new Contract(config.contractId);

  const tx = new TransactionBuilder(account, {
    fee: BASE_FEE,
    networkPassphrase: config.passphrase,
  })
    .addOperation(contract.call(method, ...args))
    .setTimeout(30)
    .build();

  onStage?.("simulating");
  const simResult = await server.simulateTransaction(tx);
  if (rpc.Api?.isSimulationError?.(simResult) ?? simResult?.error) {
    if (isContractNotFoundError(simResult)) {
      throw contractNotFoundError(config.contractId);
    }
    throw new SorobanCallError(`Simulation failed: ${simResult.error}`, "NetworkError");
  }

  const preparedTx = (rpc.assembleTransaction ?? sdk.assembleTransaction)(tx, simResult).build();

  onStage?.("awaiting_approval");
  const { signedTxXdr, error: signError } = await signTransaction(
    preparedTx.toXDR(),
    { networkPassphrase: config.passphrase },
  );

  if (signError) {
    const msg = typeof signError === "string" ? signError : (signError as Error).message;
    if (/reject|cancel|denied/i.test(msg)) {
      throw new SorobanCallError("Transaction was rejected in wallet.", "WalletRejected");
    }
    throw new SorobanCallError(msg, "Unknown");
  }

  const signedTx = TransactionBuilder.fromXDR(signedTxXdr, config.passphrase);
  const sendResult = await server.sendTransaction(signedTx);

  if (sendResult.status === "ERROR") {
    throw new SorobanCallError(
      `Transaction failed: ${sendResult.errorResult?.toXDR?.("base64") ?? "unknown error"}`,
      "NetworkError",
    );
  }

  const txHash = sendResult.hash;
  onStage?.("submitted", txHash);
  const SUCCESS = rpc.Api?.GetTransactionStatus?.SUCCESS ?? "SUCCESS";
  const FAILED  = rpc.Api?.GetTransactionStatus?.FAILED  ?? "FAILED";

  for (let i = 0; i < 20; i++) {
    await wait(1000);
    const status = await server.getTransaction(txHash);
    if (status.status === SUCCESS) return { success: true, txHash };
    if (status.status === FAILED) {
      throw new SorobanCallError("Transaction failed on-chain.", "NetworkError");
    }
  }

  throw new SorobanCallError("Transaction confirmation timed out.", "TransactionTimeout");
}

export function toSorobanErrorMessage(error: unknown): string {
  if (error instanceof SorobanCallError) return error.message;
  if (error instanceof Error) {
    const msg = error.message;
    if (/reject|cancel|denied/i.test(msg)) return "Transaction was rejected in your wallet.";
    if (/timeout/i.test(msg)) return "Transaction timed out. The network may be congested — please try again.";
    if (/insufficient/i.test(msg)) return "Insufficient balance to complete this transaction.";
    if (/simulation/i.test(msg)) return "Contract simulation failed. Check your inputs and try again.";
    return msg;
  }
  return "An unexpected error occurred. Please try again.";
}

export async function createStream(
  session: WalletSession,
  params: CreateStreamParams,
  onStage?: TransactionStageCallback,
): Promise<SorobanResult> {
  const { Address, nativeToScVal } = await import("@stellar/stellar-sdk");
  return freighterCall(session.publicKey, "create_stream", [
    new Address(session.publicKey).toScVal(),
    new Address(params.recipient).toScVal(),
    new Address(params.tokenAddress).toScVal(),
    nativeToScVal(params.amount, { type: "i128" }),
    nativeToScVal(params.durationSeconds, { type: "u64" }),
  ], onStage);
}

export async function topUpStream(
  session: WalletSession,
  params: TopUpParams,
  onStage?: TransactionStageCallback,
): Promise<SorobanResult> {
  const { Address, nativeToScVal } = await import("@stellar/stellar-sdk");
  return freighterCall(session.publicKey, "top_up_stream", [
    new Address(session.publicKey).toScVal(),
    nativeToScVal(params.streamId, { type: "u64" }),
    nativeToScVal(params.amount, { type: "i128" }),
  ], onStage);
}

export async function cancelStream(
  session: WalletSession,
  params: CancelParams,
  onStage?: TransactionStageCallback,
): Promise<SorobanResult> {
  const { Address, nativeToScVal } = await import("@stellar/stellar-sdk");
  return freighterCall(session.publicKey, "cancel_stream", [
    new Address(session.publicKey).toScVal(),
    nativeToScVal(params.streamId, { type: "u64" }),
  ], onStage);
}

export async function withdrawFromStream(
  session: WalletSession,
  params: WithdrawParams,
  onStage?: TransactionStageCallback,
): Promise<SorobanResult> {
  const { Address, nativeToScVal } = await import("@stellar/stellar-sdk");
  return freighterCall(session.publicKey, "withdraw", [
    new Address(session.publicKey).toScVal(),
    nativeToScVal(params.streamId, { type: "u64" }),
  ], onStage);
}

export async function batchWithdrawFromStreams(
  session: WalletSession,
  params: BatchWithdrawParams,
  onStage?: TransactionStageCallback,
): Promise<SorobanResult> {
  const { nativeToScVal } = await import("@stellar/stellar-sdk");
  return freighterCall(session.publicKey, "batch_withdraw", [
    // A Vec needs its element type, not the bare "vec" tag: `nativeToScVal`
    // encodes each entry as the given type. Produces the same ScVal as
    // `xdr.ScVal.scvVec(ids.map(...))`.
    nativeToScVal(params.streamIds, { type: ["u64"] }),
  ], onStage);
}

export async function pauseStream(
  session: WalletSession,
  params: PauseParams,
  onStage?: TransactionStageCallback,
): Promise<SorobanResult> {
  const { Address, nativeToScVal } = await import("@stellar/stellar-sdk");
  return freighterCall(session.publicKey, "pause_stream", [
    new Address(session.publicKey).toScVal(),
    nativeToScVal(params.streamId, { type: "u64" }),
  ], onStage);
}

export async function resumeStream(
  session: WalletSession,
  params: ResumeParams,
  onStage?: TransactionStageCallback,
): Promise<SorobanResult> {
  const { Address, nativeToScVal } = await import("@stellar/stellar-sdk");
  return freighterCall(session.publicKey, "resume_stream", [
    new Address(session.publicKey).toScVal(),
    nativeToScVal(params.streamId, { type: "u64" }),
  ], onStage);
}
