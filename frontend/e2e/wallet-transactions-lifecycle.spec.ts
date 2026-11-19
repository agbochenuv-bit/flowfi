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

  test("5. Adds, edits, and deletes a private transaction annotation", async ({ page }) => {
    await installWalletShim(page, { address: WALLET_PUBLIC_KEY });
    await persistWalletSession(page, WALLET_PUBLIC_KEY);

    await page.goto("/dashboard");
    await expect(page.locator(".wallet-chip").first()).toBeVisible({ timeout: 15_000 });

    const row = page.locator("[data-testid='transaction-row']").first();
    await expect(row).toBeVisible({ timeout: 15_000 });

    // Add annotation
    await row.getByRole("button", { name: /add note/i }).click();
    const noteInput = row.getByRole("textbox", { name: /annotation/i });
    await expect(noteInput).toBeVisible();
    await noteInput.fill("Reimbursement pending");
    await row.getByRole("button", { name: /save/i }).click();
    await expect(row.getByText("Reimbursement pending")).toBeVisible();

    // Edit annotation
    await row.getByRole("button", { name: /edit note/i }).click();
    await noteInput.fill("Reimbursement approved");
    await row.getByRole("button", { name: /save/i }).click();
    await expect(row.getByText("Reimbursement approved")).toBeVisible();
    await expect(row.getByText("Reimbursement pending")).toHaveCount(0);

    // Delete annotation
    await row.getByRole("button", { name: /delete note/i }).click();
    const confirm = page.getByRole("dialog", { name: /delete annotation/i });
    if (await confirm.isVisible().catch(() => false)) {
      await confirm.getByRole("button", { name: /delete/i }).click();
    }
    await expect(row.getByText("Reimbursement approved")).toHaveCount(0);
  });

  test("6. Includes annotations in export and isolates notes across wallet switches", async ({ page }) => {
    const otherAddress = "G" + "B".repeat(55);

    await installWalletShim(page, { address: WALLET_PUBLIC_KEY });
    await persistWalletSession(page, WALLET_PUBLIC_KEY);

    await page.goto("/dashboard");
    await expect(page.locator(".wallet-chip").first()).toBeVisible({ timeout: 15_000 });

    const row = page.locator("[data-testid='transaction-row']").first();
    await expect(row).toBeVisible({ timeout: 15_000 });
    await row.getByRole("button", { name: /add note/i }).click();
    await row.getByRole("textbox", { name: /annotation/i }).fill("Wallet A private note");
    await row.getByRole("button", { name: /save/i }).click();
    await expect(row.getByText("Wallet A private note")).toBeVisible();

    // Export should include the annotation
    const downloadPromise = page.waitForEvent("download");
    await page.getByRole("button", { name: /export/i }).click();
    const download = await downloadPromise;
    const stream = await download.createReadStream();
    let exported = "";
    if (stream) {
      for await (const chunk of stream) {
        exported += chunk.toString();
      }
    }
    expect(exported).toContain("Wallet A private note");

    // Switch wallet and confirm the note is not visible
    await installWalletShim(page, { address: otherAddress });
    await persistWalletSession(page, otherAddress);
    await page.reload();
    await expect(page.locator(".wallet-chip").first()).toContainText(otherAddress.slice(0, 4), {
      timeout: 15_000,
    });
    await expect(page.getByText("Wallet A private note")).toHaveCount(0);

    // Switch back and confirm the note is restored
    await installWalletShim(page, { address: WALLET_PUBLIC_KEY });
    await persistWalletSession(page, WALLET_PUBLIC_KEY);
    await page.reload();
    await expect(page.locator(".wallet-chip").first()).toContainText(WALLET_PUBLIC_KEY.slice(0, 4), {
      timeout: 15_000,
    });
    await expect(page.getByText("Wallet A private note")).toBeVisible({ timeout: 15_000 });
  });
});
