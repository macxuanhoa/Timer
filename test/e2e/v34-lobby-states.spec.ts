import { expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { mkdirSync } from 'node:fs';

/**
 * V3.4 §1 (UI-01) — NHÂN SỰ 01 · SẢNH TẦNG 1, the eight states the brief names.
 *
 * The lobby redesign was already written when the sessions stopped, but nothing
 * demonstrated it: no test walked its states, and the one screenshot script that
 * existed had never been run past 390 px. This spec is that evidence, and it
 * encodes the two properties that only measurement can prove:
 *
 *   · nothing is clipped — a card squeezed by its flex parent reported a 26 px
 *     box around 164 px of Vietnamese text, which a horizontal-only overflow
 *     check cannot see;
 *   · the next action is the thing the operator finds first — one dominant
 *     press, or an honest locked caption, and never a press the server refuses.
 *
 * Every word asserted here is the word the state machine or the server produced;
 * none of it is invented for the screen.
 */

type Phone = 'lobby' | 'corridor' | 'gate' | 'room305' | 'supervisor';

const ROLE_TAG: Record<Phone, string> = {
  lobby: '01',
  corridor: '02',
  gate: 'NPC 1',
  room305: 'NPC 2',
  supervisor: 'TRỊ',
};

async function signIn(context: BrowserContext, which: Phone): Promise<Page> {
  const page = await context.newPage();
  await page.goto(`/?station=${which}`);
  await expect(page.getByTestId('dashboard')).toBeVisible();
  await expect(page.getByTestId('role-tag')).toHaveText(ROLE_TAG[which]);
  return page;
}

async function phone(browser: Browser, which: Phone) {
  const context = await browser.newContext();
  return { context, page: await signIn(context, which) };
}

const shot = async (page: Page, name: string) => {
  mkdirSync('shots', { recursive: true });
  await page.screenshot({ path: `shots/v34-${name}.png` });
};

const tokenOf = (page: Page) =>
  page.evaluate(() => JSON.parse(localStorage.getItem('sc305.session.v1') ?? '{}').token as string);

/**
 * The clipping the brief forbids, on both axes. An element that scrolls its own
 * content, or that is pushed past the viewport edge, is a defect; a box whose
 * overflow is merely visible is not.
 */
const clipReport = (page: Page) =>
  page.evaluate(() => {
    const doc = document.documentElement;
    const clipped: string[] = [];
    for (const el of Array.from(document.querySelectorAll('[data-testid], .card, .role-band, .cta'))) {
      const cs = getComputedStyle(el);
      const cuts = (axis: 'x' | 'y') =>
        (axis === 'x' ? cs.overflowX : cs.overflowY) !== 'visible' && cs.textOverflow !== 'ellipsis';
      if (cuts('x') && el.scrollWidth > el.clientWidth + 1 && el.clientWidth > 0) {
        clipped.push(`${el.getAttribute('data-testid') ?? el.className} W ${el.scrollWidth}>${el.clientWidth}`);
      }
      if (cuts('y') && el.scrollHeight > el.clientHeight + 1 && el.clientHeight > 0) {
        clipped.push(`${el.getAttribute('data-testid') ?? el.className} H ${el.scrollHeight}>${el.clientHeight}`);
      }
    }
    return { clipped, pageOverflow: doc.scrollWidth - doc.clientWidth };
  });

async function assertReadable(page: Page, label: string) {
  const m = await clipReport(page);
  expect(m.pageOverflow, `${label}: horizontal overflow`).toBeLessThanOrEqual(0);
  expect(m.clipped, `${label}: clipped content → ${m.clipped.join(' | ')}`).toEqual([]);
}

/**
 * The acceptance bar for this screen is that the operator finds the next action
 * without hunting, so the control itself has to be inside the first screen — no
 * scrolling to discover what to press. A state with no press at all (a locked
 * wall display, a finished event) is allowed and skipped: those screens have
 * nothing to reach.
 */
async function assertActionReachable(page: Page, label: string) {
  const verdict = await page.evaluate(() => {
    const el = document.querySelector('[data-testid="primary-action"], [data-testid="waiting-state"]');
    if (!el) return { present: false };
    const r = el.getBoundingClientRect();
    return { present: true, top: Math.round(r.top), bottom: Math.round(r.bottom), height: window.innerHeight };
  });
  if (!verdict.present) return;
  expect(verdict.top, `${label}: the action starts above the viewport`).toBeGreaterThanOrEqual(0);
  expect(verdict.bottom, `${label}: the action is below the fold (${verdict.bottom} > ${verdict.height})`)
    .toBeLessThanOrEqual(verdict.height!);
}

test.describe.serial('V3.4 §1 — NHÂN SỰ 01 across its eight states', () => {
  test('no team → accepted → handed over → locked → ended → offline, at every width', async ({ browser }) => {
    test.setTimeout(300_000);
    const lobby = await phone(browser, 'lobby');
    const corridor = await phone(browser, 'corridor');
    const gate = await phone(browser, 'gate');
    const room = await phone(browser, 'room305');
    const sup = await phone(browser, 'supervisor');
    const pages = [lobby.page, corridor.page, gate.page, room.page, sup.page];

    const res = await sup.context.request.post('/api/dev/reset', { headers: { authorization: `Bearer ${await tokenOf(sup.page)}` } });
    expect(res.ok()).toBe(true);
    for (const p of pages) await p.reload();
    for (const p of pages) await expect(p.getByTestId('dashboard')).toBeVisible();

    /* ------------------------------------------------------- 1. no team yet */
    await expect(lobby.page.getByTestId('r01-identity')).toBeVisible();
    await expect(lobby.page.getByTestId('r01-role')).toHaveText('NHÂN SỰ 01');
    await expect(lobby.page.getByTestId('binding-state')).toContainText('ĐÃ GẮN VỊ TRÍ');
    await expect(lobby.page.getByTestId('r01-team-stage')).toHaveText('ĐỘI KẾ TIẾP');
    await expect(lobby.page.getByTestId('r01-team-badge')).toContainText('CHỜ NHẬN ĐỘI');
    await expect(lobby.page.getByTestId('primary-action')).toHaveText('NHẬN ĐỘI & CHO LÊN TẦNG 2');
    // The idle duration is one compact row, and it says why it is not moving.
    await expect(lobby.page.getByTestId('hero-clock')).toHaveText(/^0\d:\d\d$/);
    await expect(lobby.page.getByTestId('hero-note')).toContainText('BẮT ĐẦU');
    // Five stops, none reached.
    await expect(lobby.page.getByTestId('journey-strip')).toBeVisible();
    await expect(lobby.page.getByTestId('journey-strip')).toHaveAttribute('data-position', '0');
    await assertReadable(lobby.page, 'lobby: no team');
    await assertActionReachable(lobby.page, 'lobby: no team');
    await shot(lobby.page, 'r01-1-no-team');

    /* ------------------------------------- 2-3. next team, then accepted */
    await lobby.page.getByTestId('team-edit').click();
    await lobby.page.getByTestId('team-name').fill('Ma Tro');
    await lobby.page.getByTestId('primary-action').click();
    await expect(lobby.page.getByTestId('active-team')).toHaveAttribute('data-received', '1');
    // Accepted is not playing: the headline must not claim a running round.
    await expect(lobby.page.getByTestId('r01-team-stage')).toHaveText('ĐỘI VỪA NHẬN');
    await expect(lobby.page.getByTestId('r01-team-badge')).toContainText('ĐÃ NHẬN ĐỘI');
    await expect(lobby.page.getByTestId('team-status')).toContainText('Ma Tro');
    await expect(lobby.page.getByTestId('team-identity')).toContainText('đã nhận lúc');
    await assertReadable(lobby.page, 'lobby: team accepted');
    await shot(lobby.page, 'r01-2-accepted');

    /* ------------------------------------------- 4. awaiting CORRIDOR */
    await expect(lobby.page.getByTestId('waiting-state')).toContainText('ĐÃ CHO ĐỘI LÊN TẦNG 2');
    await expect(lobby.page.getByTestId('primary-action')).toHaveCount(0);
    await expect(lobby.page.getByTestId('r01-hand')).toHaveText('CHỜ 02');
    await expect(lobby.page.getByTestId('event-state')).toContainText('Chờ Nhân sự 02 xác nhận tầng 2');

    /* ------------------------------- 4b. offline while the handoff is pending */
    // Measured here, with a live workflow on screen, because this is the state
    // where a phone could otherwise pretend it still knows the truth.
    await lobby.page.context().setOffline(true);
    for (let i = 0; i < 40; i++) {
      const s = await lobby.page.getByTestId('connection').getAttribute('data-status');
      if (s !== 'CONNECTED') break;
      await lobby.page.waitForTimeout(1_000);
    }
    await expect(lobby.page.getByTestId('connection')).not.toHaveAttribute('data-status', 'CONNECTED', { timeout: 5_000 });
    await expect(lobby.page.getByTestId('sync-retry')).toBeVisible();
    // The identity band and the card both switch to the transport truth, and the
    // handoff caption stays a caption: no press is offered into an unread state.
    await expect(lobby.page.getByTestId('r01-identity')).toHaveAttribute('data-sync', 'broken');
    await expect(lobby.page.getByTestId('r01-team-badge')).toContainText('KHÔNG ĐỌC ĐƯỢC MÁY CHỦ');
    await expect(lobby.page.getByTestId('primary-action')).toHaveCount(0);
    await assertReadable(lobby.page, 'lobby: offline');
    await assertActionReachable(lobby.page, 'lobby: offline');
    await shot(lobby.page, 'r01-6-offline');
    await lobby.page.context().setOffline(false);
    await expect(lobby.page.getByTestId('connection')).toHaveAttribute('data-status', 'CONNECTED', { timeout: 40_000 });
    await expect(lobby.page.getByTestId('r01-identity')).toHaveAttribute('data-sync', 'live');

    await corridor.page.getByTestId('primary-action').click();

    /* ------------------------------------------- 5. handoff complete */
    await expect(lobby.page.getByTestId('prestart-alert')).toBeVisible({ timeout: 20_000 });
    await expect(lobby.page.getByTestId('prestart-team')).toContainText('MA TRO');
    await expect(lobby.page.getByTestId('prestart-duration')).toHaveText(/^0\d:\d\d$/);
    await expect(lobby.page.getByTestId('prestart-hint')).toContainText('NPC 1 đang phổ biến luật');
    // The pre-start banner is the phase statement, so the card's state line keeps
    // only whose hand the round is in, and the warning strip drops its duplicate.
    await expect(lobby.page.getByTestId('event-state')).toHaveText('CHỜ NPC 1');
    await expect(lobby.page.getByTestId('alert-PRESTART')).toHaveCount(0);
    await expect(lobby.page.getByTestId('waiting-state')).toContainText('ĐỘI CHƠI SẮP BẮT ĐẦU');
    await assertReadable(lobby.page, 'lobby: handoff complete');
    await assertActionReachable(lobby.page, 'lobby: handoff complete');
    await shot(lobby.page, 'r01-3-handoff-complete');

    /* ------------------------------------- 6. active round, read-only */
    await gate.page.getByTestId('primary-action').click();
    await expect(lobby.page.getByTestId('big-screen')).toBeVisible({ timeout: 20_000 });
    await expect(lobby.page.getByTestId('primary-action')).toHaveCount(0);
    await expect(lobby.page.getByTestId('open-settings')).toHaveCount(0);
    await lobby.page.keyboard.press('Escape');
    await expect(lobby.page.getByTestId('countdown-screen')).toBeVisible();
    await assertReadable(lobby.page, 'lobby: round locked');
    await shot(lobby.page, 'r01-4-locked');

    /* ------------------------------------- 7. the round is closed properly */
    // END_EVENT is not allowed over an open round, so the floor is handed back the
    // way a real shift does it: NPC 1's guarded exit, the physical resets, finalize.
    await gate.page.getByTestId('emergency-open').click();
    await expect(gate.page.getByTestId('emergency-confirm')).toBeDisabled();
    await gate.page.getByTestId('emergency-reason').fill('Kết ca theo kế hoạch');
    await gate.page.getByTestId('emergency-confirm').click();
    await expect(gate.page.getByTestId('primary-action')).toHaveText('XÁC NHẬN ĐÃ RESET HÀNH LANG', { timeout: 20_000 });
    await gate.page.getByTestId('primary-action').click();
    await room.page.getByTestId('primary-action').click();
    await expect(gate.page.getByTestId('primary-action')).toHaveText('XÁC NHẬN SẴN SÀNG', { timeout: 20_000 });
    await gate.page.getByTestId('primary-action').click();
    // Between teams the lobby owns its press again, with the next number queued.
    await expect(lobby.page.getByTestId('primary-action')).toHaveText('NHẬN ĐỘI & CHO LÊN TẦNG 2', { timeout: 20_000 });
    await expect(lobby.page.getByTestId('r01-team-stage')).toHaveText('ĐỘI KẾ TIẾP');

    /* ------------------------------------- 8. event ended */
    await sup.page.getByTestId('open-details').click();
    await sup.page.getByTestId('sheet-tab-admin').click();
    await sup.page.getByTestId('close-reason').fill('Hết ca');
    await sup.page.getByTestId('admin-end').click();
    await expect(lobby.page.getByTestId('event-ended-card')).toBeVisible({ timeout: 20_000 });
    await expect(lobby.page.getByTestId('event-ended-summary')).toContainText('đóng lúc');
    await expect(lobby.page.getByTestId('primary-action')).toHaveCount(0);
    await expect(lobby.page.getByTestId('open-new-event')).toHaveCount(0);
    await assertReadable(lobby.page, 'lobby: event ended');
    await shot(lobby.page, 'r01-5-ended');

    for (const { context } of [lobby, corridor, gate, room, sup]) await context.close();
  });

  test('the same screen stays readable at every phone width', async ({ browser }) => {
    test.setTimeout(240_000);
    // The state walk above ends the event, and an ended event replaces the
    // station screen entirely. Open a fresh night so this sweep measures the
    // lobby it is meant to measure.
    const sup = await phone(browser, 'supervisor');
    const reset = await sup.context.request.post('/api/dev/reset', { headers: { authorization: `Bearer ${await tokenOf(sup.page)}` } });
    expect(reset.ok()).toBe(true);
    await sup.context.close();

    for (const width of [320, 360, 375, 390, 414, 430]) {
      const context = await browser.newContext({ viewport: { width, height: 640 } });
      const lobby = await signIn(context, 'lobby');
      await expect(lobby.getByTestId('r01-identity')).toBeVisible();
      await assertReadable(lobby, `lobby at ${width}px`);
      // 640 px of height is the shortest phone in the brief's list, so this is
      // where “find the action without hunting” is actually tested.
      await assertActionReachable(lobby, `lobby at ${width}px`);
      if (width === 320) await shot(lobby, 'r01-320');
      await context.close();
    }
  });
});
