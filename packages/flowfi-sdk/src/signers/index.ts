/**
 * Modular signer adapters for FlowFi client-side signing.
 *
 * The `FlowFiClient` never holds private keys itself. Instead it delegates
 * signing to a `Signer`, so the same client works in browsers (Freighter),
 * Node.js daemons (raw secret key), and custom setups (WalletConnect /
 * hardware wallets).
 */

import { abortable, runWithCancellation, throwIfAborted } from '../cancellation.js';
import type { OperationOptions } from '../cancellation.js';

export interface Signer {
  /** Public key (G...) that will appear as the transaction source / invoker. */
  getPublicKey(opts?: OperationOptions): Promise<string> | string;
  /**
   * Sign a base64 transaction envelope and return the signed envelope XDR.
   *
   * Implementations must NOT submit the transaction — submission is handled
   * by `FlowFiClient` so simulation/assembly stays in one place.
   */
  signTransaction(envelopeXdr: string, opts?: SignerOptions): Promise<string>;
}

export interface SignerOptions extends OperationOptions {
  networkPassphrase?: string;
}

/** Generic callback-based signer for WalletConnect / hardware wallets. */
export class CustomSigner implements Signer {
  private publicKey: string;
  private signFn: (envelopeXdr: string, options?: OperationOptions) => Promise<string>;

  constructor(publicKey: string, signFn: (envelopeXdr: string, options?: OperationOptions) => Promise<string>) {
    this.publicKey = publicKey;
    this.signFn = signFn;
  }

  getPublicKey(opts?: OperationOptions): string {
    throwIfAborted(opts?.signal);
    return this.publicKey;
  }

  async signTransaction(envelopeXdr: string, opts?: SignerOptions): Promise<string> {
    return runWithCancellation(opts, async (signal) => {
      throwIfAborted(signal);
      return abortable(this.signFn(envelopeXdr, { signal }), signal);
    });
  }
}

/**
 * Node.js signer backed by a raw Stellar secret key (S...).
 *
 * Intended for automated payroll daemons and backend bots. Do NOT bundle a
 * production secret into frontend code.
 */
export class KeypairSigner implements Signer {
  private secret: string;

  constructor(secret: string) {
    if (!secret.startsWith('S')) {
      throw new Error('KeypairSigner expects a Stellar secret key starting with "S"');
    }
    this.secret = secret;
  }

  async getPublicKey(opts?: OperationOptions): Promise<string> {
    return runWithCancellation(opts, async (signal) => {
      const { Keypair } = await abortable(import('@stellar/stellar-sdk'), signal);
      return Keypair.fromSecret(this.secret).publicKey();
    });
  }

  async signTransaction(envelopeXdr: string, opts?: SignerOptions): Promise<string> {
    return runWithCancellation(opts, async (signal) => {
      const { Keypair, TransactionBuilder } = await abortable(import('@stellar/stellar-sdk'), signal);
      throwIfAborted(signal);
      const networkPassphrase = opts?.networkPassphrase ?? 'Test SDF Network ; September 2015';
      const keypair = Keypair.fromSecret(this.secret);
      const tx = TransactionBuilder.fromXDR(envelopeXdr, networkPassphrase);
      if (typeof tx !== 'object' || tx === null || !('sign' in tx)) {
        throw new Error('KeypairSigner: envelope XDR is not a signable transaction');
      }
      (tx as { sign: (kp: unknown) => void }).sign(keypair);
      throwIfAborted(signal);
      return (tx as { toXDR: () => string }).toXDR();
    });
  }
}

/**
 * In-browser signer backed by the Freighter extension.
 *
 * Lazily imports `@stellar/freighter-api` so Node.js consumers never pay the
 * browser-only dependency cost unless they instantiate this class.
 */
export class FreighterSigner implements Signer {
  async getPublicKey(opts?: OperationOptions): Promise<string> {
    return runWithCancellation(opts, async (signal) => {
      const freighter = await abortable(import('@stellar/freighter-api'), signal);
      const { address } = await abortable(freighter.requestAccess(), signal);
      if (!address) {
        throw new Error('FreighterSigner: no address returned — is Freighter installed and unlocked?');
      }
      return address;
    });
  }

  async signTransaction(envelopeXdr: string, opts?: SignerOptions): Promise<string> {
    return runWithCancellation(opts, async (signal) => {
      const freighter = await abortable(import('@stellar/freighter-api'), signal);
      const signed = await abortable(freighter.signTransaction(envelopeXdr, {
        networkPassphrase: opts?.networkPassphrase,
      }), signal);
      throwIfAborted(signal);
      if (typeof signed === 'string') return signed;
      // Newer freighter-api returns `{ signedTxXdr }`.
      const maybe = signed as unknown as { signedTxXdr?: string };
      if (maybe.signedTxXdr) return maybe.signedTxXdr;
      throw new Error('FreighterSigner: unexpected signTransaction response shape');
    });
  }
}
