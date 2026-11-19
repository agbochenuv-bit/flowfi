import { test, expect } from "@playwright/test";
import { installFreighterMock, WALLET_PUBLIC_KEY } from "./utils/freighter";

test("connects a Freighter wallet, shows the account badge, and disconnects", async ({
  page,
}) => {
  await installFreighterMock(page);

  await page.goto("/");

  const connectButton = page.locator(".wallet-connect-btn").first();
  await expect(connectButton).toBeVisible({ timeout: 30_000 });
  await connectButton.click();

  const dialog = page.getByRole("dialog", { name: "Connect a wallet" });
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "Connect Freighter" }).click();

  const chip = page.locator(".wallet-chip").first();
  await expect(chip).toBeVisible({ timeout: 15_000 });
  await expect(chip).toContainText(WALLET_PUBLIC_KEY.slice(0, 4));

  await chip.click();
  await page.getByRole("menuitem", { name: "Disconnect" }).click();
  await expect(page.locator(".wallet-connect-btn").first()).toBeVisible();
});

test("shows a persistent active-network indicator across navigation", async ({
  page,
}) => {
  await installFreighterMock(page);

  await page.goto("/");

  const indicator = page.locator(".active-network-indicator").first();
  await expect(indicator).toBeVisible({ timeout: 30_000 });
  await expect(indicator).toContainText(/testnet/i);

  // The indicator must remain visible after navigating to another route.
  await page.goto("/contracts");
  await expect(page.locator(".active-network-indicator").first()).toBeVisible();
  await expect(page.locator(".active-network-indicator").first()).toContainText(
    /testnet/i,
  );
});

test("requires confirmation before switching networks with pending actions", async ({
  page,
}) => {
  await installFreighterMock(page);

  await page.goto("/");

  const indicator = page.locator(".active-network-indicator").first();
  await expect(indicator).toBeVisible({ timeout: 30_000 });

  // Seed a pending action so the switch must be confirmed.
  await page.evaluate(() => {
    window.localStorage.setItem(
      "stellar:pending-actions",
      JSON.stringify([
        { id: "pending-1", kind: "invoke", status: "pending" },
      ]),
    );
  });
  await page.reload();

  await page.locator(".active-network-indicator").first().click();

  const confirmDialog = page.getByRole("dialog", {
    name: /switch network/i,
  });
  await expect(confirmDialog).toBeVisible();
  await expect(confirmDialog).toContainText(/pending/i);

  // Cancelling keeps the current network active.
  await confirmDialog.getByRole("button", { name: /cancel/i }).click();
  await expect(page.locator(".active-network-indicator").first()).toContainText(
    /testnet/i,
  );

  // Confirming switches the active network.
  await page.locator(".active-network-indicator").first().click();
  const confirmAgain = page.getByRole("dialog", { name: /switch network/i });
  await expect(confirmAgain).toBeVisible();
  await confirmAgain.getByRole("button", { name: /confirm|switch/i }).click();
  await expect(page.locator(".active-network-indicator").first()).toContainText(
    /mainnet/i,
  );
});

test("shows a wallet mismatch banner when the wallet network differs", async ({
  page,
}) => {
  await installFreighterMock(page, { network: "PUBLIC" });

  await page.goto("/");

  const connectButton = page.locator(".wallet-connect-btn").first();
  await expect(connectButton).toBeVisible({ timeout: 30_000 });
  await connectButton.click();

  const dialog = page.getByRole("dialog", { name: "Connect a wallet" });
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "Connect Freighter" }).click();

  const banner = page.locator(".wallet-network-mismatch").first();
  await expect(banner).toBeVisible({ timeout: 15_000 });
  await expect(banner).toContainText(/network/i);
});