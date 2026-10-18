import type { Page } from "@playwright/test";
import { WALLET_PUBLIC_KEY, SESSION_STORAGE_KEY } from "./freighter";

export interface WalletShimOptions {
  address?: string;
  network?: "TESTNET" | "PUBLIC" | "FUTURENET";
  rejectSignature?: boolean;
  signatureDelayMs?: number;
  rejectConnection?: boolean;
}

/**
 * Builds an enhanced, controllable Freighter/Stellar wallet provider shim.
 * Supports configurable network matching, signature rejection, pending delays,
 * and session persistence.
 */
export function buildWalletShimScript(options: WalletShimOptions = {}): string {
  const address = options.address || WALLET_PUBLIC_KEY;
  const network = options.network || "TESTNET";
  const rejectSignature = !!options.rejectSignature;
  const signatureDelayMs = options.signatureDelayMs || 0;
  const rejectConnection = !!options.rejectConnection;

  return `
    (() => {
      const address = ${JSON.stringify(address)};
      const network = ${JSON.stringify(network)};
      const rejectSignature = ${JSON.stringify(rejectSignature)};
      const signatureDelayMs = ${JSON.stringify(signatureDelayMs)};
      const rejectConnection = ${JSON.stringify(rejectConnection)};

      window.freighter = { version: "controlled-shim" };

      const respond = (messageId, payload) => {
        window.postMessage(
          {
            source: "FREIGHTER_EXTERNAL_MSG_RESPONSE",
            messagedId: messageId,
            extensionName: "FREIGHTER",
            apiVersion: 1,
            ...payload,
          },
          window.location.origin,
        );
      };

      window.addEventListener("message", (event) => {
        if (event.source !== window) return;
        const data = event.data || {};
        if (data.source !== "FREIGHTER_EXTERNAL_MSG_REQUEST") return;

        switch (data.type) {
          case "REQUEST_ACCESS":
          case "REQUEST_PUBLIC_KEY":
            if (rejectConnection) {
              respond(data.messageId, {
                error: { code: -1, message: "User rejected connection request" },
              });
            } else {
              respond(data.messageId, { publicKey: address, error: undefined });
            }
            break;

          case "REQUEST_CONNECTION_STATUS":
            respond(data.messageId, { isConnected: !rejectConnection });
            break;

          case "REQUEST_ALLOWED_STATUS":
          case "SET_ALLOWED_STATUS":
            respond(data.messageId, { isAllowed: !rejectConnection });
            break;

          case "REQUEST_NETWORK_DETAILS":
            respond(data.messageId, {
              networkDetails: {
                network: network,
                networkName: network === "PUBLIC" ? "Stellar Mainnet" : "SDF Test Network",
                networkUrl: network === "PUBLIC" ? "https://horizon.stellar.org" : "https://horizon-testnet.stellar.org",
                networkPassphrase: network === "PUBLIC" ? "Public Global Stellar Network ; September 2015" : "Test SDF Network ; September 2015",
                sorobanRpcUrl: network === "PUBLIC" ? "https://soroban-rpc.stellar.org" : "https://soroban-testnet.stellar.org",
              },
              error: undefined,
            });
            break;

          case "SUBMIT_TRANSACTION":
          case "SIGN_TRANSACTION":
            if (rejectSignature) {
              setTimeout(() => {
                respond(data.messageId, {
                  error: { code: -3, message: "User rejected transaction signature" },
                });
              }, signatureDelayMs);
            } else {
              setTimeout(() => {
                respond(data.messageId, {
                  signedTransaction: data.transactionXdr || "mock_signed_xdr_payload",
                  signerAddress: address,
                  error: undefined,
                });
              }, signatureDelayMs);
            }
            break;

          default:
            respond(data.messageId, {
              error: { code: -2, message: "Unsupported shim request: " + data.type },
            });
            break;
        }
      });
    })();
  `;
}

/**
 * Installs the controlled wallet provider shim into the browser context.
 */
export async function installWalletShim(
  page: Page,
  options: WalletShimOptions = {}
): Promise<void> {
  await page.addInitScript(buildWalletShimScript(options));
}

/**
 * Persists an active wallet session into browser localStorage.
 */
export async function persistWalletSession(
  page: Page,
  address: string = WALLET_PUBLIC_KEY,
  network: string = "Testnet"
): Promise<void> {
  await page.addInitScript(
    ({ key, storageKey, net }) => {
      window.localStorage.setItem(
        storageKey,
        JSON.stringify({
          walletId: "freighter",
          walletName: "Freighter",
          publicKey: key,
          connectedAt: new Date().toISOString(),
          network: net,
          mocked: false,
        })
      );
    },
    { key: address, storageKey: SESSION_STORAGE_KEY, net: network }
  );
}
