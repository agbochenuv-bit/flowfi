import { Keypair, TransactionBuilder } from '@stellar/stellar-sdk';
import { runWithCancellation, throwIfAborted } from '../cancellation.js';
import type { Signer, SignerOptions } from './index.js';

export interface MobileWalletOptions {
  walletLink: string;
  returnLink: string;
  publicKey: string;
  networkPassphrase: string;
  /** Launch the verified universal link and await one callback, removing listeners on abort. */
  handoff(link: string, signal: AbortSignal): Promise<string>;
}

function endpoint(value: string) {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password || url.href.includes('?') || url.href.includes('#')) {
    throw new Error('Expected a plain HTTPS universal link');
  }
  return url.href;
}

function equalBytes(a: Uint8Array, b: Uint8Array) {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

export class MobileWalletSigner implements Signer {
  private readonly config: Readonly<MobileWalletOptions>;

  constructor(options: MobileWalletOptions) {
    Keypair.fromPublicKey(options.publicKey);
    if (!options.networkPassphrase) throw new Error('Missing network');
    this.config = { ...options, walletLink: endpoint(options.walletLink), returnLink: endpoint(options.returnLink) };
  }

  getPublicKey(options?: SignerOptions) {
    throwIfAborted(options?.signal);
    return this.config.publicKey;
  }

  signTransaction(envelope: string, options?: SignerOptions) {
    const config = this.config;
    return runWithCancellation(options, async signal => {
      if (options?.networkPassphrase !== config.networkPassphrase) throw new Error('Network mismatch');
      const original = TransactionBuilder.fromXDR(envelope, config.networkPassphrase);
      const state = crypto.randomUUID();
      const request = new URL(config.walletLink);
      request.search = new URLSearchParams({
        state, envelope, network: config.networkPassphrase, account: config.publicKey, returnLink: config.returnLink,
      }).toString();
      const response = new URL(await config.handoff(request.href, signal));
      throwIfAborted(signal);
      const params = response.searchParams;
      if (response.href.split('?')[0] !== config.returnLink || response.hash ||
          params.get('state') !== state || params.get('network') !== config.networkPassphrase ||
          ['state', 'network', 'status', 'envelope'].some(key => params.getAll(key).length > 1)) {
        throw new Error('Invalid wallet callback');
      }
      if (params.get('status') === 'cancelled') throw new DOMException('Wallet cancelled', 'AbortError');
      const signed = params.get('envelope');
      if (!signed || params.get('status') !== 'signed') throw new Error('Missing signed envelope');
      const tx = TransactionBuilder.fromXDR(signed, config.networkPassphrase);
      const key = Keypair.fromPublicKey(config.publicKey);
      if (!equalBytes(tx.hash(), original.hash()) ||
          !original.signatures.every(sig => tx.signatures.some(s => equalBytes(s.toXDR(), sig.toXDR()))) ||
          !tx.signatures.some(sig => equalBytes(sig.hint.value, key.signatureHint()) && key.verify(tx.hash(), sig.signature.value))) {
        throw new Error('Wallet returned a different transaction or invalid signature');
      }
      return signed;
    });
  }
}
