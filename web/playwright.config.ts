import { defineConfig } from "@playwright/test";

// E2E against an already-running dev server (npm run dev:lan). Uses bundled chromium
// (no Chrome channel needed). Run: npm run e2e
export default defineConfig({
  testDir: "./e2e",
  timeout: 30_000,
  fullyParallel: false,
  reporter: [["list"]],
  use: {
    baseURL: process.env.E2E_BASE_URL ?? "http://localhost:3000",
    headless: true,
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
    viewport: { width: 1280, height: 900 },
  },
  projects: [{ name: "chromium", use: { browserName: "chromium" } }],
});
