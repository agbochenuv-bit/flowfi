import { Account, Keypair, Networks, TransactionBuilder, Operation } from '@stellar/stellar-sdk';
import { expect, it } from 'vitest';
import { MobileWalletSigner } from '../src/signers/mobile.js';

const key = Keypair.random();
const networkPassphrase = Networks.TESTNET;
const tx = new TransactionBuilder(new Account(key.publicKey(), '0'), { fee: '100', networkPassphrase })
  .addOperation(Operation.manageData({name: 'demo', value: 'test'})).setTimeout(30).build();
const envelope = tx.toXDR();
tx.sign(key);
it.each(['signed', 'host', 'state', 'network', 'duplicate', 'unsigned', 'cancelled'])('handles %s callback', async mode => {
  const signer = new MobileWalletSigner({
    walletLink: 'https://wallet.example/sign', returnLink: 'https://app.example/return',
    publicKey: key.publicKey(), networkPassphrase,
    async handoff(link) {
      const url = new URL(new URL(link).searchParams.get('returnLink')!);
      if (mode === 'host') url.hostname += '.invalid';
      url.searchParams.set('state', mode === 'state' ? '' : new URL(link).searchParams.get('state')!);
      url.searchParams.set('network', mode === 'network' ? Networks.PUBLIC : networkPassphrase);
      url.searchParams.set('status', mode === 'cancelled' ? mode : 'signed');
      url.searchParams.set('envelope', mode === 'unsigned' ? envelope : tx.toXDR());
      if (mode === 'duplicate') url.searchParams.append('state', 'extra');
      return url.href;
    },
  });
  const result = signer.signTransaction(envelope, {networkPassphrase});
  if (mode === 'signed') expect(await result).toBe(tx.toXDR());
  else await expect(result).rejects.toThrow();
});

it('rejects a mismatched network before opening the wallet', async () => {
  const signer = new MobileWalletSigner({
    publicKey: key.publicKey(), networkPassphrase, returnLink: 'https://app.example/return',
    walletLink: 'https://wallet.example/sign', handoff: async () => { throw Error('Unexpected handoff'); },
  });
  await expect(signer.signTransaction(envelope, {networkPassphrase: Networks.PUBLIC})).rejects.toThrow('Network mismatch');
});

it('cancels an outstanding handoff and signals the host to remove its listener', async () => {
  const controller = new AbortController();
  let hostSignal: AbortSignal | undefined;
  const signer = new MobileWalletSigner({
    publicKey: key.publicKey(), networkPassphrase, returnLink: 'https://app.example/return',
    walletLink: 'https://wallet.example/sign',
    handoff: (_link, signal) => {
      hostSignal = signal;
      return new Promise(() => {});
    },
  });
  const pending = signer.signTransaction(envelope, { networkPassphrase, signal: controller.signal });
  await Promise.resolve();
  controller.abort();
  await expect(pending).rejects.toMatchObject({name: 'AbortError'});
  expect(hostSignal?.aborted).toBe(true);
});
