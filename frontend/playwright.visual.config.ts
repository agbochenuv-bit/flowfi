import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./visual",
  testMatch: "*.spec.ts",
  retries: 0,
  reporter: "list",
  use: {
    ...devices["Desktop Chrome"],
    baseURL: "http://127.0.0.1:3103",
    locale: "en-US",
    timezoneId: "UTC",
    colorScheme: "dark",
    reducedMotion: "reduce",
  },
  webServer: {
    command: "npx vite --config visual/vite.config.ts",
    url: "http://127.0.0.1:3103",
    reuseExistingServer: !process.env.CI,
  },
});
