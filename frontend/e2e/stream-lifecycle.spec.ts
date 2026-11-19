import { test, expect } from "@playwright/test";
import { mockConnectedWallet, RECIPIENT_PUBLIC_KEY } from "./utils/freighter";

const MOCK_API_URL = "http://localhost:3100";

const SENDER_PUBLIC_KEY = "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5";
const SCHEDULE_ID = "7";
const SCHEDULE_AMOUNT = "250";
const SCHEDULE_INTERVAL_LABEL = "Weekly";
=======

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

test.describe("recurring payment schedules", () => {
  test.beforeEach(async ({ page }) => {
    await mockConnectedWallet(page, SENDER_PUBLIC_KEY);
  });

  test("previews next run and funding requirement before confirming a schedule", async ({
    page,
  }) => {
    await page.goto("/schedules/new");

    await page.getByLabel(/recipient/i).fill(RECIPIENT_PUBLIC_KEY);
    await page.getByLabel(/amount/i).fill(SCHEDULE_AMOUNT);
    await page.getByLabel(/interval/i).selectOption("weekly");

    const preview = page.getByTestId("schedule-preview");
    await expect(preview).toBeVisible({ timeout: 20_000 });

    // Next-run preview must be shown before the user confirms.
    await expect(preview.getByTestId("schedule-next-run")).toBeVisible();
    await expect(preview.getByTestId("schedule-next-run")).not.toBeEmpty();

    // Funding requirement preview must reflect the schedule amount.
    const funding = preview.getByTestId("schedule-funding-requirement");
    await expect(funding).toBeVisible();
    await expect(funding).toContainText(SCHEDULE_AMOUNT);

    // The confirm button is only actionable once the preview is present.
    const confirmButton = page.getByRole("button", { name: /confirm|create schedule/i });
    await expect(confirmButton).toBeEnabled();

    await confirmButton.click();

    await expect(page.getByText(/schedule created/i)).toBeVisible({ timeout: 30_000 });
    await expect(page).toHaveURL(new RegExp(`/schedules/${SCHEDULE_ID}`));
  });

  test("shows each generated stream as a separate payment obligation", async ({ page }) => {
    await page.goto(`/schedules/${SCHEDULE_ID}`);

    const obligations = page.getByTestId("payment-obligation");
    await expect(obligations.first()).toBeVisible({ timeout: 30_000 });

    // Each generated stream is rendered as its own obligation row.
    await expect(obligations).toHaveCount(3, { timeout: 20_000 });

    const firstObligation = obligations.nth(0);
    const secondObligation = obligations.nth(1);
    await expect(firstObligation).toContainText(SCHEDULE_AMOUNT);
    await expect(secondObligation).toContainText(SCHEDULE_AMOUNT);

    // Obligations are distinct entries, not a single aggregated balance.
    await expect(firstObligation).not.toHaveText(
      (await secondObligation.textContent()) ?? "",
    );
  });

  test("surfaces a missed-run state for an overdue schedule", async ({ page }) => {
    await page.goto(`/schedules/${SCHEDULE_ID}`);

    const missedRun = page.getByTestId("schedule-missed-run");
    await expect(missedRun).toBeVisible({ timeout: 30_000 });
    await expect(missedRun).toContainText(/missed/i);

    // A missed run must not silently advance the schedule as if it succeeded.
    await expect(page.getByTestId("schedule-status")).not.toContainText(/completed/i);
  });

  test("blocks confirmation when funds are insufficient", async ({ page }) => {
    await page.goto("/schedules/new");

    await page.getByLabel(/recipient/i).fill(RECIPIENT_PUBLIC_KEY);
    await page.getByLabel(/amount/i).fill("999999999");
    await page.getByLabel(/interval/i).selectOption("weekly");

    const insufficient = page.getByTestId("schedule-insufficient-funds");
    await expect(insufficient).toBeVisible({ timeout: 20_000 });
    await expect(insufficient).toContainText(/insufficient/i);

    const confirmButton = page.getByRole("button", { name: /confirm|create schedule/i });
    await expect(confirmButton).toBeDisabled();
  });

  test("cancels a schedule and stops further obligations", async ({ page }) => {
    await page.goto(`/schedules/${SCHEDULE_ID}`);

    const cancelButton = page.getByRole("button", { name: /cancel schedule/i });
    await expect(cancelButton).toBeEnabled({ timeout: 30_000 });
    await cancelButton.click();

    // Cancellation requires explicit confirmation.
    const confirmCancel = page.getByRole("button", { name: /confirm cancel/i });
    await expect(confirmCancel).toBeVisible();
    await confirmCancel.click();

    await expect(page.getByText(/schedule cancelled/i)).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId("schedule-status")).toContainText(/cancelled/i);

    // No new obligations should be generated after cancellation.
    const obligations = page.getByTestId("payment-obligation");
    const countAfterCancel = await obligations.count();
    await page.waitForTimeout(2_000);
    await expect(obligations).toHaveCount(countAfterCancel);
  });

  test("blocks schedule creation on a wallet-network mismatch", async ({ page }) => {
    // Simulate a wallet connected to a different network than the app expects.
    await page.route("**/__e2e/wallet/network", (route) =>
      route.fulfill({ status: 200, body: JSON.stringify({ network: "PUBLIC" }) }),
    );

    await page.goto("/schedules/new");

    const mismatch = page.getByTestId("wallet-network-mismatch");
    await expect(mismatch).toBeVisible({ timeout: 20_000 });
    await expect(mismatch).toContainText(/network/i);

    const confirmButton = page.getByRole("button", { name: /confirm|create schedule/i });
    await expect(confirmButton).toBeDisabled();
  });
});