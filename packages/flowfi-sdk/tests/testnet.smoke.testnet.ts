import { beforeAll, describe, expect, it } from 'vitest';
import {
  FlowFiClient,
  KeypairSigner,
  buildContractCallXdr,
  buildWithdrawXdr,
  simulateAndAssemble,
} from '../src/index.js';

const rpcUrl = process.env.FLOWFI_TESTNET_RPC_URL;
const contractId = process.env.FLOWFI_TESTNET_CONTRACT_ID;
const secret = process.env.FLOWFI_TESTNET_SOURCE_SECRET;
const streamIdInput = process.env.FLOWFI_TESTNET_STREAM_ID;
if (!rpcUrl || !contractId || !secret || !streamIdInput) {
  throw new Error(
    'Testnet smoke requires FLOWFI_TESTNET_RPC_URL, FLOWFI_TESTNET_CONTRACT_ID, FLOWFI_TESTNET_SOURCE_SECRET, and FLOWFI_TESTNET_STREAM_ID',
  );
}
if (!/^C[A-Z2-7]{55}$/.test(contractId) || !secret.startsWith('S') || !/^\d+$/.test(streamIdInput)) {
  throw new Error('Testnet smoke configuration contains an invalid contract ID, secret key, or stream ID');
}

const streamId = BigInt(streamIdInput);
const networkPassphrase = 'Test SDF Network ; September 2015';
const signer = new KeypairSigner(secret);
let publicKey = '';
let client: FlowFiClient;

describe('FlowFi SDK Testnet smoke', () => {
  beforeAll(async () => {
    publicKey = await signer.getPublicKey();
    client = new FlowFiClient({
      rpcUrl,
      networkPassphrase,
      contractId,
      readOnlySourceAccount: publicKey,
    });
  });

  it('builds generated transaction call envelopes', async () => {
    const xdr = await buildWithdrawXdr(streamId, publicKey, {
      sourceAccount: publicKey,
      contractId,
      networkPassphrase,
    });
    expect(xdr).toMatch(/^[A-Za-z0-9+/]+=*$/);
  });

  it('simulates a contract call and signs the assembled envelope without submitting', async () => {
    const { nativeToScVal } = await import('@stellar/stellar-sdk');
    const unsignedXdr = await buildContractCallXdr({
      sourceAccount: publicKey,
      contractId,
      networkPassphrase,
      method: 'get_claimable_amount',
      methodArgs: [nativeToScVal(streamId, { type: 'u64' })],
    });
    const simulation = await simulateAndAssemble({
      unsignedXdr,
      networkPassphrase,
      rpcUrl,
    });
    expect(simulation.assembledXdr).toBeTruthy();
    expect(simulation.resourceFee).toMatch(/^\d+$/);
    await expect(signer.signTransaction(simulation.assembledXdr, { networkPassphrase })).resolves.toBeTruthy();
  });

  it('reads the configured stream and claimable amount from Testnet', async () => {
    const [stream, claimable] = await Promise.all([
      client.getStream(streamId),
      client.getClaimableAmount(streamId),
    ]);
    expect(stream).not.toBeNull();
    expect(stream?.streamId).toBe(streamId);
    expect(claimable).toBeGreaterThanOrEqual(0n);
  });
});