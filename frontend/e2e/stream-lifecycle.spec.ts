import { test, expect, type Page } from "@playwright/test";
import { mockConnectedWallet, RECIPIENT_PUBLIC_KEY } from "./utils/freighter";

const MOCK_API_URL = "http://localhost:3100";

/**
 * Opens the stream detail page as the stream SENDER and returns the preview
 * panel locator. The preview is rendered side-by-side (before/after) for every
 * mutating action so the user can review the impact before signing.
 */
async function openPreview(page: Page, action: string) {
  await page.goto("/streams/42");
  await page.getByRole("button", { name: new RegExp(action, "i") }).first().click();
  const preview = page.getByTestId("stream-change-preview");
  await expect(preview).toBeVisible({ timeout: 20_000 });
  return preview;
}

async function expectBeforeAfter(
  preview: ReturnType<Page["getByTestId"]>,
  before: string,
  after: string,
) {
  await expect(preview.getByTestId("preview-before")).toContainText(before);
  await expect(preview.getByTestId("preview-after")).toContainText(after);
}

test("stream detail page shows stream state and reflects a withdrawal via mock events", async ({
  page,
}) => {
  // Connect as the stream RECIPIENT so the Withdraw action is available.
  await mockConnectedWallet(page, RECIPIENT_PUBLIC_KEY);

  await page.goto("/streams/42");

  const withdrawnCard = page.locator(".glass-card", { hasText: "Withdrawn" }).first();
  const claimableCard = page.locator(".glass-card", { hasText: "Claimable" }).first();

  await expect(withdrawnCard).toContainText("0 USDC", { timeout: 30_000 });
  // Live claimable is capped at the deposited amount by the dashboard contract.
  await expect(claimableCard).toContainText("10000 USDC", { timeout: 30_000 });

  const bump = await page.request.post(`${MOCK_API_URL}/__e2e/stream/42/withdraw`);
  expect(bump.ok()).toBeTruthy();

  await expect(withdrawnCard).toContainText("10 USDC", { timeout: 20_000 });

  const eventRow = page
    .locator("div.flex.items-center.gap-4.py-3", { hasText: "Withdrawn" })
    .first();
  await expect(eventRow).toBeVisible({ timeout: 20_000 });

  const withdrawnButton = page
    .getByRole("button", { name: /Withdraw/, exact: false })
    .first();
  await expect(withdrawnButton).toBeEnabled();
  await withdrawnButton.click();

  await expect(page.getByText("Withdrawal successful!")).toBeVisible({
    timeout: 30_000,
  });
});

test.describe("side-by-side stream change previews", () => {
  test.beforeEach(async ({ page }) => {
    // The sender owns every mutating action below.
    await mockConnectedWallet(page);
  });

  test("top-up preview shows before/after deposited amount", async ({ page }) => {
    const preview = await openPreview(page, "Top up");

    await page.getByLabel(/amount/i).fill("250");
    await expectBeforeAfter(preview, "10000 USDC", "10250 USDC");
    await expect(preview.getByTestId("preview-assumptions")).toContainText(
      /no rounding/i,
    );
  });

  test("schedule update preview shows before/after end date", async ({ page }) => {
    const preview = await openPreview(page, "Update schedule");

    await page.getByLabel(/end date/i).fill("2026-01-01");
    await expect(preview.getByTestId("preview-before")).toContainText("End date");
    await expect(preview.getByTestId("preview-after")).toContainText("2026-01-01");
  });

  test("beneficiary change preview shows before/after recipient", async ({ page }) => {
    const preview = await openPreview(page, "Change beneficiary");

    await page.getByLabel(/new recipient/i).fill(RECIPIENT_PUBLIC_KEY);
    await expectBeforeAfter(preview, "G...", RECIPIENT_PUBLIC_KEY.slice(0, 5));
  });

  test("cancellation preview warns that remaining funds are refunded", async ({
    page,
  }) => {
    const preview = await openPreview(page, "Cancel");

    await expect(preview.getByTestId("preview-after")).toContainText(/refund/i);
    await expect(preview.getByTestId("preview-assumptions")).toContainText(
      /cancellation is final/i,
    );
  });

  test("signing is blocked when the preview is stale", async ({ page }) => {
    const preview = await openPreview(page, "Top up");
    await page.getByLabel(/amount/i).fill("250");
    await expectBeforeAfter(preview, "10000 USDC", "10250 USDC");

    // Mutate authoritative state behind the preview's back.
    const bump = await page.request.post(`${MOCK_API_URL}/__e2e/stream/42/withdraw`);
    expect(bump.ok()).toBeTruthy();

    await expect(preview.getByTestId("preview-stale")).toBeVisible({
      timeout: 20_000,
    });
    const signButton = page.getByRole("button", { name: /sign/i }).first();
    await expect(signButton).toBeDisabled();
  });

  test("signing is blocked when the wallet prompt is canceled", async ({ page }) => {
    await page.addInitScript(() => {
      // Simulate the user dismissing the Freighter signing prompt.
      (window as unknown as { __e2eCancelSign: boolean }).__e2eCancelSign = true;
    });

    const preview = await openPreview(page, "Top up");
    await page.getByLabel(/amount/i).fill("250");
    await expectBeforeAfter(preview, "10000 USDC", "10250 USDC");

    await page.getByRole("button", { name: /sign/i }).first().click();
    await expect(page.getByText(/signing canceled/i)).toBeVisible({
      timeout: 20_000,
    });
    await expect(page.getByText(/successful/i)).toHaveCount(0);
  });
});