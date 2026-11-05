import { mkdirSync } from 'node:fs';
import { expect, type Page } from '@playwright/test';

/**
 * Shared visual-regression measurements for the V3.4 station screens.
 *
 * These live here rather than inside one spec because the same three properties
 * have to hold for every role, and the version that only measured horizontal
 * overflow is what let a flex-squeezed card clip Vietnamese text on two screens
 * while the suite stayed green. One definition, used by every station spec.
 */

/** Writes a rendered screenshot of the current state into shots/. */
export const shot = async (page: Page, name: string) => {
  mkdirSync('shots', { recursive: true });
  await page.screenshot({ path: `shots/v34-${name}.png` });
};

/**
 * Clipping on BOTH axes, plus the page-level horizontal overflow. An element
 * whose overflow is `visible` is not clipped — that is how a letter-spaced,
 * fit-content label measures — and `text-overflow: ellipsis` is a deliberate
 * truncation, not a defect.
 */
export const clipReport = (page: Page) =>
  page.evaluate(() => {
    const doc = document.documentElement;
    const clipped: string[] = [];
    for (const el of Array.from(document.querySelectorAll('[data-testid], .card, .role-band, .cta, .state-block'))) {
      const cs = getComputedStyle(el);
      const id = el.getAttribute('data-testid') ?? el.className;
      const cuts = (axis: 'x' | 'y') =>
        (axis === 'x' ? cs.overflowX : cs.overflowY) !== 'visible' && cs.textOverflow !== 'ellipsis';
      if (cuts('x') && el.scrollWidth > el.clientWidth + 1 && el.clientWidth > 0) {
        clipped.push(`${id} W ${el.scrollWidth}>${el.clientWidth}`);
      }
      if (cuts('y') && el.scrollHeight > el.clientHeight + 1 && el.clientHeight > 0) {
        clipped.push(`${id} H ${el.scrollHeight}>${el.clientHeight}`);
      }
    }
    return { pageOverflow: doc.scrollWidth - doc.clientWidth, clipped };
  });

export async function assertReadable(page: Page, label: string) {
  const m = await clipReport(page);
  expect(m.pageOverflow, `${label}: horizontal overflow`).toBeLessThanOrEqual(0);
  expect(m.clipped, `${label}: clipped content → ${m.clipped.join(' | ')}`).toEqual([]);
}

/**
 * "Identify the next action within two seconds" as a number: the control, or the
 * read-only summary that replaced it, has to be inside the first screen. States
 * with no action at all (a locked wall display, a finished event) are skipped.
 */
export async function assertActionReachable(page: Page, label: string) {
  const verdict = await page.evaluate(() => {
    const el = document.querySelector(
      '[data-testid="primary-action"], [data-testid="waiting-state"], [data-testid="r02-handoff-summary"]',
    );
    if (!el) return { present: false as const };
    const r = el.getBoundingClientRect();
    return { present: true as const, top: Math.round(r.top), bottom: Math.round(r.bottom), height: window.innerHeight };
  });
  if (!verdict.present) return;
  expect(verdict.top, `${label}: the action starts above the viewport`).toBeGreaterThanOrEqual(0);
  expect(verdict.bottom, `${label}: the action is below the fold (${verdict.bottom} > ${verdict.height})`)
    .toBeLessThanOrEqual(verdict.height);
}

/**
 * How many times a sentence is rendered on the visible screen. The brief forbids
 * stating the same fact in several cards, and a count is the only way to keep
 * that from creeping back in.
 */
export const countSentences = (page: Page, needle: string) =>
  page.evaluate((text) => {
    let hits = 0;
    for (const el of Array.from(document.querySelectorAll('p, span, button, h1, h2'))) {
      const own = Array.from(el.childNodes)
        .filter((n) => n.nodeType === 3)
        .map((n) => n.textContent ?? '')
        .join('');
      if (own.toUpperCase().includes(text.toUpperCase())) hits += 1;
    }
    return hits;
  }, needle);
