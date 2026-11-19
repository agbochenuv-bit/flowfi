import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e/wallet-compat",
  retries: 0,
  workers: 1,
  forbidOnly: Boolean(process.env.CI),
  use: { baseURL: "http://127.0.0.1:3111", serviceWorkers: "block" },
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"] } },
    { name: "firefox", use: { ...devices["Desktop Firefox"] } },
  ],
  webServer: [
    {
      command: "vite --config e2e/wallet-compat/vite.config.mts",
      url: "http://127.0.0.1:3111/e2e/wallet-compat/",
    },
    {
      command: "node e2e/mocks/api-server.mjs",
      url: "http://localhost:3110/health",
      env: { MOCK_API_PORT: "3110", MOCK_RPC_PORT: "3112", MOCK_RPC_HTTP: "1", E2E_APP_ORIGIN: "http://127.0.0.1:3111" },
    },
  ],
});
