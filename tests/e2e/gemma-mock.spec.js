// =============================================================
// gemma-mock.spec.js — full ask → reply path with a mocked Gemini
// streamGenerateContent route. Verifies:
//   1. The gemma connector hits the *native* Gemini endpoint (not
//      the OpenAI-compat shim — that 500s on Gemma model IDs) and
//      passes a `systemInstruction`.
//   2. The reply renders in the chat thread.
//   3. The translation rule holds — no banned words appear in any
//      visible UI text.
// =============================================================

import { test, expect } from '@playwright/test';
import { CANNED_SPEC, BANNED_WORDS, makeSSE } from './fixtures/canned-spec.js';

const GEMMA_KEY = 'test-key-not-real';

// Preset localStorage so the page boots with gemma already selected
// and a (fake) key in place. Skips the settings-panel dance AND the
// first-visit welcome overlay (by setting wonderlab.name).
async function bootWithGemma(page) {
  await page.addInitScript((key) => {
    localStorage.setItem('wonderlab.name', 'tester');
    localStorage.setItem('wonderlab.connector.settings.v1', JSON.stringify({
      backend: 'gemma',
      keys: { gemma: key },
      models: { gemma: 'gemma-4-31b-it' },
      lmstudioUrl: 'http://localhost:1234/v1/chat/completions',
      drawIllustrations: true,
      language: 'en',
      level: 'curious',
    }));
  }, GEMMA_KEY);
}

test.describe('gemma 4 ask path (mocked)', () => {
  test('mocked Gemma stream renders reply + respects translation rule', async ({ page }) => {
    await bootWithGemma(page);

    // Capture the outgoing request so we can assert function calling
    // is wired correctly.
    let capturedRequestBody = null;

    await page.route(
      '**/generativelanguage.googleapis.com/v1beta/models/**:streamGenerateContent**',
      async (route) => {
        try { capturedRequestBody = JSON.parse(route.request().postData() || '{}'); } catch {}
        await route.fulfill({
          status: 200,
          contentType: 'text/event-stream',
          body: makeSSE(CANNED_SPEC),
        });
      },
    );

    await page.goto('/');

    // Ask the question
    const input = page.locator('#ask-input');
    await input.fill("why doesn't a cooked egg go back to runny?");
    await page.locator('#ask-submit').click();

    // The reply should land in the chat thread eventually
    const thread = page.locator('#chat-thread');
    await expect(thread).toContainText(/tiny strings/i, { timeout: 15_000 });
    await expect(thread).toContainText(/knot/i);

    // The request must have used the *native* Gemini endpoint with a
    // systemInstruction (not the OpenAI-compat shim).
    expect(capturedRequestBody, 'request body captured').toBeTruthy();
    expect(capturedRequestBody.systemInstruction?.parts?.[0]?.text)
      .toMatch(/Iris/);
    expect(capturedRequestBody.contents?.[0]?.role).toBe('user');

    // Translation-rule invariant: no banned word may appear anywhere
    // the visitor can see. We collect the *visible* text from the
    // chat thread + the whiteboard SVG and assert the list is clean.
    const visibleText = await page.evaluate(() => {
      const parts = [];
      const grab = (sel) => {
        document.querySelectorAll(sel).forEach((el) => {
          if (el.offsetParent !== null || el.tagName === 'text') {
            parts.push(el.textContent || '');
          }
        });
      };
      grab('#chat-thread');
      grab('.answer-card');
      grab('svg text');
      return parts.join(' ').toLowerCase();
    });

    for (const word of BANNED_WORDS) {
      expect(
        visibleText.includes(word.toLowerCase()),
        `banned word "${word}" must not be in visible UI`,
      ).toBe(false);
    }
  });
});
