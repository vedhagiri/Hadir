import { defineConfig, devices } from "@playwright/test";

// Pilot smoke runs against the live compose stack. The default
// baseURL points at the Vite dev server proxied to the backend; the
// CI script (or operator) must have `docker compose up` running before
// `npm run smoke` is invoked.

export default defineConfig({
  testDir: "./tests",
  fullyParallel: false,
  retries: 0,
  reporter: "list",
  use: {
    baseURL: "http://localhost:5173",
    trace: "off",
    screenshot: "off",
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
});
