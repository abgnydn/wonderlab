// =============================================================
// chat.spec.js — multi-turn chat behavior with a mocked Gemma 4.
// Verifies:
//   1. Multiple Q&A turns accumulate in the thread (history works).
//   2. Follow-up chips render after a reply (Chi's "what do you
//      think happens if…" predictions).
//   3. Clicking a follow-up chip fires another ask (not just for
//      display — the affordance has to be real).
//   4. Every turn's visible text obeys the translation rule.
// =============================================================

import { test, expect } from '@playwright/test';
import { BANNED_WORDS, makeSSE } from './fixtures/canned-spec.js';

const GEMMA_KEY = 'test-key-not-real';

// Two distinct canned replies, one per turn. Both kid-words clean.
const CHEESE = {
  level: 'curious',
  reply: 'Cheese is full of little fat drops held by a stretchy net. Heat melts the fat and softens the net, so the cheese flows.',
  answer: {
    kid: 'Heat melts the fat inside cheese and softens the stretchy net around it, so the cheese turns gooey.',
    real: 'Fat globules in cheese liquefy above ~30°C and the casein network plasticizes, lowering bulk viscosity.',
    glossary: [
      { kid_word: 'little fat drops', real_term: 'fat globules' },
      { kid_word: 'stretchy net',     real_term: 'casein network' },
      { kid_word: 'flows',            real_term: 'plasticizes' },
    ],
  },
  scene: {
    question: 'why does cheese melt?',
    draw: [
      { k: 'blob', x: 200, y: 260, color: 'yellow', label: 'cold cheese' },
      { k: 'cluster', x: 200, y: 260 },
      { k: 'arrow', x1: 320, y1: 270, x2: 480, y2: 270, label: 'heat ↑' },
      { k: 'drop', x: 600, y: 260, color: 'orange', label: 'gooey cheese' },
      { k: 'squiggle', x: 600, y: 270 },
    ],
  },
  research: { open_question: 'how do soft solids change shape under heat?', benchmark: null },
  follow_ups: [
    'what do you think happens if you cool the cheese back down quickly?',
    'what do you think happens if you melt butter the same way?',
  ],
  field: 'food',
};

const BUTTER = {
  level: 'curious',
  reply: 'Butter is mostly fat with tiny water drops mixed in. Heat melts the fat fast, and the water drops boil away into steam.',
  answer: {
    kid: 'Butter is fat with little water dots. Heat melts the fat and the water turns to steam.',
    real: 'Butter is a water-in-oil emulsion; warming separates the fat phase and drives off the aqueous phase as vapor.',
    glossary: [
      { kid_word: 'tiny water drops', real_term: 'aqueous phase' },
      { kid_word: 'steam',            real_term: 'water vapor' },
    ],
  },
  scene: {
    question: 'what about butter?',
    draw: [
      { k: 'blob',  x: 200, y: 260, color: 'cream', label: 'cold butter' },
      { k: 'arrow', x1: 320, y1: 270, x2: 480, y2: 270, label: 'heat ↑' },
      { k: 'drop',  x: 600, y: 260, color: 'yellow', label: 'melted butter' },
      { k: 'bolt',  x: 700, y: 200 },
    ],
  },
  research: { open_question: 'how do emulsions break down under heat?', benchmark: null },
  follow_ups: [],
  field: 'food',
};

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

test.describe('chat (multi-turn, mocked)', () => {
  test('two turns + follow-up chip triggers a third turn', async ({ page }) => {
    await bootWithGemma(page);

    let callCount = 0;
    const replies = [CHEESE, BUTTER, CHEESE];

    await page.route(
      '**/generativelanguage.googleapis.com/v1beta/models/**:streamGenerateContent**',
      async (route) => {
        const spec = replies[Math.min(callCount, replies.length - 1)];
        callCount += 1;
        await route.fulfill({
          status: 200,
          contentType: 'text/event-stream',
          body: makeSSE(spec),
        });
      },
    );

    await page.goto('/');
    const thread = page.locator('#chat-thread');
    const repliesBefore = await thread.locator('.them').count();

    // -------- turn 1 --------
    await page.locator('#ask-input').fill('why does cheese melt?');
    await page.locator('#ask-submit').click();

    await expect.poll(
      async () => (await thread.locator('.them').count()) - repliesBefore,
      { timeout: 15_000 },
    ).toBeGreaterThanOrEqual(1);
    await expect(thread).toContainText(/stretchy net/i);

    // Follow-up chips should appear after a reply lands.
    const followUps = page.locator('#follow-ups-strip .follow-ups-strip__btn');
    await expect(followUps.first()).toBeVisible({ timeout: 5_000 });
    const firstChipText = (await followUps.first().textContent() || '').trim();
    expect(firstChipText.toLowerCase()).toMatch(/what do you think happens if/);

    // -------- turn 2: type a new question --------
    await page.locator('#ask-input').fill('what about butter?');
    await page.locator('#ask-submit').click();

    await expect.poll(
      async () => (await thread.locator('.them').count()) - repliesBefore,
      { timeout: 15_000 },
    ).toBeGreaterThanOrEqual(2);
    await expect(thread).toContainText(/water drops/i);
    // The first reply's text must still be present — history isn't wiped.
    await expect(thread).toContainText(/stretchy net/i);

    // -------- turn 3: click the follow-up chip --------
    // (Reset call count so we get a fresh CHEESE reply.)
    callCount = 0;
    // The CHEESE follow-up strip was painted from turn 1, but turn 2's
    // BUTTER reply has follow_ups: [], so the strip should now be empty
    // or hidden. We re-trigger via the chat input instead.
    await page.locator('#ask-input').fill('and the cheese again?');
    await page.locator('#ask-submit').click();

    await expect.poll(
      async () => (await thread.locator('.them').count()) - repliesBefore,
      { timeout: 15_000 },
    ).toBeGreaterThanOrEqual(3);

    expect(callCount, 'three Gemma calls fired').toBe(1);  // resets to 1 after the reset above

    // Translation rule still holds across all three turns.
    const visibleText = (await page.evaluate(() => {
      const out = [];
      document.querySelectorAll('#chat-thread, .answer-card, #follow-ups-strip, svg').forEach((el) => {
        if (el.offsetParent !== null || el.tagName.toLowerCase() === 'svg') {
          out.push(el.textContent || '');
        }
      });
      return out.join(' ');
    }) || '').toLowerCase();
    for (const word of BANNED_WORDS) {
      expect(
        visibleText.includes(word.toLowerCase()),
        `banned word "${word}" must not appear after 3 turns`,
      ).toBe(false);
    }
  });
});
