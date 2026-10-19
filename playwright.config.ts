import { defineConfig, devices } from "@playwright/test";

// `vite preview` serves the production web build on port 4173.
// The build runs first so dist/ always matches the current source.
export default defineConfig({
  testDir: "./e2e",
  timeout: 30_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  reporter: "list",
  use: {
    baseURL: "http://localhost:4173",
    trace: "retain-on-failure",
  },
  webServer: {
    command: "npm run build && npm run preview -- --port 4173 --strictPort",
    url: "http://localhost:4173",
    reuseExistingServer: false,
    timeout: 240_000,
  },
  projects: [
    {
      name: "desktop",
      use: { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 900 } },
    },
    {
      name: "narrow",
      // style.css sets `body { min-width: 920px }`, so 920px is the smallest
      // width the layout supports without horizontal overflow.
      use: { ...devices["Desktop Chrome"], viewport: { width: 920, height: 700 } },
    },
  ],
});
