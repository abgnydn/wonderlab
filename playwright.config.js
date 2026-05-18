// =============================================================
// playwright.config.js — E2E test config for wonderlab.
//
// Auto-starts the static dev server (npm run dev:static, port
// 5173) before any test runs. Tests live in tests/e2e/.
//
// Run: npm run test:e2e        (headless)
//      npm run test:e2e:headed (watch the browser)
//
// Provision once: npx playwright install chromium
// =============================================================

import { defineConfig, devices } from '@playwright/test';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Tiny .env loader — picks up GEMINI_API_KEY (and friends) for the live
// Gemma 4 spec without pulling in dotenv as a dep. Skips silently if no
// .env exists; never overrides values already in the shell.
const __dirname = dirname(fileURLToPath(import.meta.url));
const ENV_PATH = join(__dirname, '.env');
if (existsSync(ENV_PATH)) {
  for (const line of readFileSync(ENV_PATH, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/i);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^['"]|['"]$/g, '');
  }
}

const PORT = process.env.WONDER_E2E_PORT || 5174;
const BASE_URL = `http://localhost:${PORT}`;

export default defineConfig({
  testDir: './tests/e2e',
  timeout: 30_000,
  expect: { timeout: 5_000 },
  fullyParallel: false,                       // one server, one browser
  retries: 0,
  workers: 1,
  reporter: process.env.CI ? 'github' : 'list',

  use: {
    baseURL: BASE_URL,
    headless: true,
    viewport: { width: 1440, height: 900 },
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    // wonderlab uses localStorage for settings — give each test a clean slate
    storageState: { cookies: [], origins: [] },
  },

  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],

  webServer: {
    command: `npx -y http-server@14 -p ${PORT} -c-1 .`,
    url: BASE_URL,
    reuseExistingServer: !process.env.CI,
    stdout: 'ignore',
    stderr: 'pipe',
    timeout: 30_000,
  },
});
