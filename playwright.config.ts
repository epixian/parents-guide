import { defineConfig, devices } from "@playwright/test";

// Browser tests against the running dev servers (Vite on 127.0.0.1:5188 and
// the API behind it). Start them first (the Solo processes "Client" and
// "API"); these tests do not start or stop servers. Run: npm run test:e2e
export default defineConfig({
  testDir: "e2e",
  // The dev servers are shared: keep the load low.
  workers: 2,
  reporter: "list",
  use: {
    // 127.0.0.1, not localhost: Vite listens on IPv4 only.
    baseURL: process.env.E2E_BASE_URL ?? "http://127.0.0.1:5188",
    trace: "retain-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
