import { expect, test } from '@playwright/test';

/**
 * V3.4 — role-selection screen visual & responsive contract.
 *
 * The picker is the operational gateway of the night: it must render the full
 * board (brand header, honest overview, four duty cards, separate viewer band)
 * without clipping, overflow or duplicated numbering at every real phone width
 * in the venue, and it must use a purposeful desktop layout rather than a
 * stretched phone. Every case also leaves a screenshot for visual QA.
 */
const WIDTHS = [320, 360, 375, 390, 414, 430] as const;

async function openPicker(page: import('@playwright/test').Page, width: number, height = 780) {
  await page.setViewportSize({ width, height });
  await page.goto('/');
  await expect(page.getByTestId('scream-home')).toBeVisible();
  // The overview answers only from the server board: four duty seats, ten viewer
  // seats — never the old aggregate that also carried the hidden admin seats.
  await expect(page.getByTestId('station-count')).toHaveText(/\d\/4/);
  await expect(page.getByTestId('observer-count')).toHaveText(/\d\/10/);
}

for (const width of WIDTHS) {
  test(`picker renders the full board with no overflow at ${width}px`, async ({ page }) => {
    await openPicker(page, width);
    await expect(page.getByTestId('home-overview')).toBeVisible();
    await expect(page.locator('.home-station')).toHaveCount(4);
    await expect(page.locator('.home-observer-card')).toHaveCount(1);
    // The redesign removed the repeated numbering and the decorative arrows:
    // neither may come back on any width.
    await expect(page.locator('.home-station-number, .home-station-arrow')).toHaveCount(0);
    // Each card carries its full Vietnamese identity, not a truncated label.
    await expect(page.getByTestId('station-LOBBY')).toContainText('NHÂN SỰ 01');
    await expect(page.getByTestId('station-LOBBY')).toContainText('SẢNH TẦNG 1');
    await expect(page.getByTestId('station-CORRIDOR')).toContainText('NHÂN SỰ 02');
    await expect(page.getByTestId('station-GATE')).toContainText('NPC 1');
    await expect(page.getByTestId('station-GATE')).toContainText('TẦNG 3');
    await expect(page.getByTestId('station-ROOM305')).toContainText('NPC 2');
    await expect(page.getByTestId('station-ROOM305')).toContainText('PHÒNG 305');
    // The viewer band is separated from the duty grid and explains read-only.
    await expect(page.getByTestId('station-OBSERVER')).toContainText('Chỉ đọc');
    // No horizontal overflow, and no card clipped off the bottom of the shell.
    const overflow = await page.evaluate(() =>
      document.documentElement.scrollWidth - window.innerWidth);
    expect(overflow, `horizontal overflow ${overflow}px at ${width}px`).toBeLessThanOrEqual(0);
    await page.screenshot({ path: `shots/v34-picker-${width}.png`, fullPage: true });
  });
}

test('desktop uses a purposeful two-column board, not stretched mobile cards', async ({ page }) => {
  await openPicker(page, 1280, 800);
  const columns = await page.locator('.home-stations')
    .evaluate(el => getComputedStyle(el).gridTemplateColumns.split(' ').length);
  expect(columns, 'duty grid columns').toBe(2);
  const measure = await page.locator('.home-content')
    .evaluate(el => (el as HTMLElement).getBoundingClientRect().width);
  expect(measure, 'content measure').toBeLessThanOrEqual(880);
  const overflow = await page.evaluate(() =>
    document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow).toBeLessThanOrEqual(0);
  await page.screenshot({ path: 'shots/v34-picker-desktop-1280.png', fullPage: true });
});

test('keyboard users can walk every seat in walking order', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByTestId('scream-home')).toBeVisible();
  const focused = () => page.evaluate(() => document.activeElement?.getAttribute('data-testid') ?? '');
  await page.getByTestId('station-LOBBY').focus();
  expect(await focused()).toBe('station-LOBBY');
  for (const next of ['station-CORRIDOR', 'station-GATE', 'station-ROOM305', 'station-OBSERVER']) {
    await page.keyboard.press('Tab');
    expect(await focused(), `Tab reaches ${next}`).toBe(next);
  }
});

test('screen readers get person, place and real state on every card', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('button', { name: /NHÂN SỰ 01 — SẢNH TẦNG 1\. CÒN TRỐNG/ })).toBeVisible();
  await expect(page.getByRole('button', { name: /NPC 2 — PHÒNG 305\./ })).toBeVisible();
  // The viewer band names its capacity class, not a raw role key.
  await expect(page.getByRole('button', { name: /Quan sát trực tiếp/ })).toBeVisible();
});

test('reduced motion renders the steady board with every state still legible', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/');
  await expect(page.getByTestId('scream-home')).toBeVisible();
  await expect(page.getByTestId('station-LOBBY')).toHaveAttribute('data-state', 'available');
  // Nothing animates under reduce: the available cue is the rail and the badge.
  const animations = await page.evaluate(() =>
    document.getAnimations().filter(a => a.playState === 'running').length);
  expect(animations, 'running animations under reduced motion').toBe(0);
  await page.screenshot({ path: 'shots/v34-picker-reduced-motion.png', fullPage: true });
});
