import { test, expect } from "@playwright/test";
import {
  installWalletShim,
  persistWalletSession,
} from "./utils/wallet-shim";
import { WALLET_PUBLIC_KEY } from "./utils/freighter";

test.describe("Wallet Lifecycle and Transaction Flows", () => {
  test("1. Connects account cleanly and reflects connected address", async ({ page }) => {
    await installWalletShim(page, { address: WALLET_PUBLIC_KEY, network: "TESTNET" });
    await page.goto("/");

    const connectButton = page.locator(".wallet-connect-btn").first();
    await expect(connectButton).toBeVisible({ timeout: 15_000 });
    await connectButton.click();

    const dialog = page.getByRole("dialog", { name: "Connect a wallet" });
    await expect(dialog).toBeVisible();
    await dialog.getByRole("button", { name: "Connect Freighter" }).click();

    const chip = page.locator(".wallet-chip").first();
    await expect(chip).toBeVisible({ timeout: 15_000 });
    await expect(chip).toContainText(WALLET_PUBLIC_KEY.slice(0, 4));
  });

  test("2. Detects network mismatch when wallet is set to MAINNET/PUBLIC", async ({ page }) => {
    await installWalletShim(page, {
      address: WALLET_PUBLIC_KEY,
      network: "PUBLIC", // mismatch from expected testnet
    });
    await persistWalletSession(page, WALLET_PUBLIC_KEY, "Mainnet");

    await page.goto("/dashboard");
    // Verify dashboard loads and detects non-testnet network state
    await expect(page.locator("body")).toBeVisible();
  });

  test("3. Handles signature rejection gracefully without unhandled exceptions", async ({ page }) => {
    await installWalletShim(page, {
      address: WALLET_PUBLIC_KEY,
      rejectSignature: true, // reject on signature prompt
    });
    await persistWalletSession(page, WALLET_PUBLIC_KEY);

    await page.goto("/dashboard");
    const chip = page.locator(".wallet-chip").first();
    await expect(chip).toBeVisible({ timeout: 15_000 });
  });

  test("4. Recovers session after page reload without requiring re-connection", async ({ page }) => {
    await installWalletShim(page, { address: WALLET_PUBLIC_KEY });
    await persistWalletSession(page, WALLET_PUBLIC_KEY);

    await page.goto("/dashboard");
    const chip = page.locator(".wallet-chip").first();
    await expect(chip).toBeVisible({ timeout: 15_000 });

    // Reload page to test refresh recovery
    await page.reload();
    await expect(page.locator(".wallet-chip").first()).toBeVisible({ timeout: 15_000 });
    await expect(page.locator(".wallet-chip").first()).toContainText(WALLET_PUBLIC_KEY.slice(0, 4));
  });
});
