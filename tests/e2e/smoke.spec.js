// =============================================================
// smoke.spec.js — page loads, key UI is reachable, no console
// errors. Runs against the static dev server (no API calls).
// =============================================================

import { test, expect } from '@playwright/test';

// Skip the first-visit welcome overlay by presetting a visitor name.
test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem('wonderlab.name', 'tester');
  });
});

test.describe('smoke', () => {
  test('landing page renders and links into the lab', async ({ page }) => {
    const consoleErrors = [];
    page.on('pageerror', (err) => consoleErrors.push(err.message));

    await page.goto('/landing.html');
    await expect(page).toHaveTitle(/wonderlab/);

    // Hero copy
    await expect(page.locator('h1.hero__lede')).toContainText(/any question/);

    // Gemma 4 chip is the FIRST model chip (recommended path)
    const firstChip = page.locator('.models__chips .model-chip').first();
    await expect(firstChip).toContainText(/Gemma 4/);

    // "open the lab" CTA links to /
    const cta = page.locator('a.cta.cta--big').first();
    await expect(cta).toHaveAttribute('href', '/');

    expect(consoleErrors, 'no JS errors on landing').toEqual([]);
  });

  test('lab room loads and settings opens', async ({ page }) => {
    const consoleErrors = [];
    page.on('pageerror', (err) => consoleErrors.push(err.message));

    await page.goto('/');

    // Core lab UI
    await expect(page.locator('#ask-input')).toBeVisible();
    await expect(page.locator('#ask-submit')).toBeVisible();
    await expect(page.locator('#settings-btn')).toBeVisible();

    // Open settings → modal shows, Gemma 4 is the first picker row
    await page.locator('#settings-btn').click();
    const modal = page.locator('#settings-modal');
    await expect(modal).toBeVisible();

    const firstBackend = page.locator('#settings-backends .settings-backend').first();
    await expect(firstBackend).toContainText(/Gemma 4/);

    expect(consoleErrors, 'no JS errors loading the lab').toEqual([]);
  });
});
