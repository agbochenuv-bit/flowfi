import { test, expect } from "@playwright/test";

for (const [name, width, height] of [["mobile", 390, 844], ["desktop", 1280, 900]] as const) {
  for (const view of ["summary", "details", "confirmation"] as const) {
    test(`${view} financial presentation at ${name} breakpoint`, async ({ page }) => {
      await page.setViewportSize({ width, height });
      await page.clock.install({ time: new Date("2023-11-16T12:00:00.000Z") });
      await page.goto(`/?view=${view}`);
      await expect(page.locator("main")).toContainText(view === "summary" ? "Rate" : view === "details" ? "Streaming Progress" : "Network fee");
      await expect(page).toHaveScreenshot(`${view}-${name}.png`, { animations: "disabled", caret: "hide" });
    });
  }
}
