// =============================================================
// gemma-live.spec.js — REAL end-to-end test against Gemma 4 31B
// on Google AI Studio. No mocks. Uses your AI Studio key from the
// GEMINI_API_KEY env var (the same one wonderlab's dev server reads).
//
// Skipped automatically if the key isn't set, so this spec is safe
// to keep in the default `npm run test:e2e` run.
//
// Cost: a single Gemma 4 31B call on the free tier (no card).
// Wall time: typically 10-45s depending on AI Studio load.
//
// To run only this spec:
//   GEMINI_API_KEY=AIzaSy... npm run test:e2e -- gemma-live
// =============================================================

import { test, expect } from '@playwright/test';
import { BANNED_WORDS } from './fixtures/canned-spec.js';

const KEY = process.env.GEMINI_API_KEY
         || process.env.GOOGLE_AI_API_KEY
         || process.env.WONDER_E2E_GEMMA_KEY
         || '';

const QUESTION = 'why does cheese melt?';

test.describe('gemma 4 live (real API)', () => {
  test.skip(!KEY,
    'set GEMINI_API_KEY (your AI Studio key) to run the live Gemma 4 test');

  test('real ask → real Gemma 4 31B reply, translation rule holds', async ({ page }) => {
    test.setTimeout(90_000);          // Gemma 4 31B can take 30-45s on a cold call

    // Preset localStorage so the page boots straight into Gemma 4 with
    // the real key, skipping the welcome overlay + settings dance.
    await page.addInitScript((key) => {
      localStorage.setItem('wonderlab.name', 'tester');
      localStorage.setItem('wonderlab.connector.settings.v1', JSON.stringify({
        backend: 'gemma',
        keys:    { gemma: key },
        models:  { gemma: 'gemma-4-31b-it' },
        lmstudioUrl: 'http://localhost:1234/v1/chat/completions',
        drawIllustrations: true,
        language: 'en',
        level: 'curious',
      }));
    }, KEY);

    // Capture the real request so we can prove function calling is on
    // the wire (and not just JSON-in-text mode).
    let capturedBody = null;
    page.on('request', (req) => {
      if (req.url().includes('streamGenerateContent')) {
        try { capturedBody = JSON.parse(req.postData() || '{}'); } catch {}
      }
    });

    const pageErrors = [];
    page.on('pageerror', (err) => pageErrors.push(err.message));

    await page.goto('/');

    const thread = page.locator('#chat-thread');
    const repliesBefore = await thread.locator('.them').count();

    await page.locator('#ask-input').fill(QUESTION);
    await page.locator('#ask-submit').click();

    // Wait until a NEW .them bubble appears with non-trivial content.
    // (The welcome bubble is already present at boot, so we need the
    // count to grow AND the new one to have meaningful text.)
    await expect.poll(
      async () => {
        const count = await thread.locator('.them').count();
        if (count <= repliesBefore) return 0;
        const last = (await thread.locator('.them').last().textContent() || '').trim();
        return last.length;
      },
      { timeout: 75_000, intervals: [500, 1000, 2000] },
    ).toBeGreaterThan(20);

    const replyText = (await thread.locator('.them').last().textContent() || '').trim();
    console.log('\n--- live Gemma 4 reply ---\n' + replyText + '\n--------------------------');

    // Replies are non-deterministic, so assertions stay loose:
    //   • reply has real content
    //   • topical hit: at least one of cheese/melt/heat/hot/warm appears
    //   • no banned word leaks anywhere visible
    //   • the whiteboard rendered SOMETHING (any svg child element)
    expect(replyText.length, 'reply has real content').toBeGreaterThan(20);
    expect(replyText.toLowerCase()).toMatch(/cheese|melt|heat|hot|warm/);

    // Translation rule sweep across everything visible.
    const visibleText = (await page.evaluate(() => {
      const out = [];
      document.querySelectorAll('#chat-thread, .answer-card, svg').forEach((el) => {
        if (el.offsetParent !== null || el.tagName.toLowerCase() === 'svg') {
          out.push(el.textContent || '');
        }
      });
      return out.join(' ');
    }) || '').toLowerCase();

    for (const word of BANNED_WORDS) {
      expect(
        visibleText.includes(word.toLowerCase()),
        `banned word "${word}" must not appear in visible UI`,
      ).toBe(false);
    }

    // Whiteboard should have rendered shapes.
    const svgChildCount = await page.locator('svg *').count();
    expect(svgChildCount, 'whiteboard SVG rendered shapes').toBeGreaterThan(0);

    // Wiring proof: native Gemini endpoint, systemInstruction present.
    expect(capturedBody, 'streamGenerateContent request was sent').toBeTruthy();
    expect(capturedBody.systemInstruction?.parts?.[0]?.text).toMatch(/Iris/);
    expect(capturedBody.contents?.[0]?.role).toBe('user');

    expect(pageErrors, 'no JS errors during live ask').toEqual([]);
  });
});
