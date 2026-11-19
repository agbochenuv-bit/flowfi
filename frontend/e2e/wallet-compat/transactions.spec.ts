import { expect, test } from "@playwright/test";
import type { connectWallet } from "@/lib/wallet";
import type { cancelStream } from "@/lib/soroban";
import { installWalletShim } from "../utils/wallet-shim";
import { WALLET_PUBLIC_KEY } from "../utils/freighter";

declare global {
  interface Window {
    connectWallet: typeof connectWallet;
    cancelStream: typeof cancelStream;
  }
}

for (const version of ["legacy", "current"] as const) {
  for (const scenario of ["success", "rejection", "simulation failure"] as const) {
    test(`${version} wallet response / ${scenario}`, async ({ page }) => {
      const methods: string[] = [];
      await installWalletShim(page, { version, rejectSignature: scenario === "rejection" });
      await page.route("**/*", async (route) => {
        const request = route.request();
        const url = new URL(request.url());
        if (url.origin === "http://127.0.0.1:3111") return route.continue();
        if (url.hostname !== "soroban-testnet.stellar.org") return route.abort();
        const headers = {
          "access-control-allow-origin": "http://127.0.0.1:3111",
          "access-control-allow-methods": "POST, OPTIONS",
          "access-control-allow-headers": "*",
        };
        if (request.method() === "OPTIONS") return route.fulfill({ status: 204, headers });
        const { method, id } = request.postDataJSON();
        methods.push(method);
        if (method === "simulateTransaction" && scenario === "simulation failure") {
          return route.fulfill({
            headers,
            json: { id, jsonrpc: "2.0", result: { error: "fixture simulation failed", latestLedger: 1000 } },
          });
        }
        const response = await route.fetch({
          url: "http://127.0.0.1:3112/soroban",
        });
        await route.fulfill({ response, headers: { ...response.headers(), ...headers } });
      });

      await page.goto("/e2e/wallet-compat/");
      await page.waitForFunction(() => Boolean(window.connectWallet));
      const result = await page.evaluate(async () => {
        const wallet = await window.connectWallet("freighter");
        const stages: string[] = [];
        const approvals: { transactionXdr: string; networkPassphrase: string }[] = [];
        window.addEventListener("message", ({ data, source }) => {
          if (source === window && data?.source === "FREIGHTER_EXTERNAL_MSG_REQUEST" &&
            data.type === "SUBMIT_TRANSACTION") {
            approvals.push({
              transactionXdr: data.transactionXdr,
              networkPassphrase: data.networkPassphrase,
            });
          }
        });
        try {
          await window.cancelStream(wallet, { streamId: 42n }, (stage) => stages.push(stage));
          return { wallet, stages, approvals, error: null };
        } catch (error) {
          return { wallet, stages, approvals, error: (error as Error).message };
        }
      });

      expect(result.wallet.publicKey).toBe(WALLET_PUBLIC_KEY);
      expect(result.wallet.network).toBe("TESTNET");
      expect(methods, result.error ?? "expected a simulation").toContain("simulateTransaction");
      if (scenario === "simulation failure") {
        expect(result.approvals).toEqual([]);
      } else {
        expect(result.approvals).toEqual([{
          transactionXdr: expect.stringMatching(/^[A-Za-z0-9+/]+=*$/),
          networkPassphrase: "Test SDF Network ; September 2015",
        }]);
      }
      if (scenario === "success") {
        expect(result.error).toBeNull();
        expect(result.stages).toEqual(["simulating", "awaiting_approval", "submitted"]);
        expect(methods).toContain("sendTransaction");
        expect(methods).toContain("getTransaction");
      } else {
        expect(methods).not.toContain("sendTransaction");
        expect(result.error).toContain(scenario === "rejection" ? "rejected in wallet" : "Simulation failed");
        expect(result.stages).toEqual(scenario === "rejection" ? ["simulating", "awaiting_approval"] : ["simulating"]);
      }
    });
  }
}
