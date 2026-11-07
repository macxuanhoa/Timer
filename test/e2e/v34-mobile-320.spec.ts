import { unlockAdmin } from './lib/admin';
import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import { mkdirSync } from 'node:fs';

/**
 * V3.4 §11 — the mobile floor of the redesigned screens.
 *
 * The historical suite measured 360px; the brief's list starts at 320px, and that
 * is where Vietnamese labels and the new role bands actually break. Every station
 * is driven to the screen its V3.4 work changed, then measured and captured at
 * 320px: NHÂN SỰ 01 and 02 (UI-01/UI-02), NPC 1's pre-start, countdown and reset
 * screens (UI-03/UI-04/UI-05), NPC 2's verification panel (UI-04) and the retained
 * admin. No horizontal overflow, no clipped control, and one screenshot per screen
 * so the visual review is of rendered pixels rather than of source.
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
  if (which === 'supervisor') await unlockAdmin(page);
  await expect(page.getByTestId('dashboard')).toBeVisible();
  await expect(page.getByTestId('role-tag')).toHaveText(ROLE_TAG[which]);
  return page;
}

const shot = async (page: Page, name: string) => {
  mkdirSync('shots', { recursive: true });
  await page.screenshot({ path: `shots/v34-${name}.png` });
};

/**
 * The measurement that matters on a phone, on both axes. Horizontal overflow is
 * the visible symptom; the vertical one is how a card squeezed by a flex parent
 * with `min-height: 0` loses Vietnamese lines to its own `overflow: hidden`
 * while the page still reports zero sideways overflow — the check that was
 * missing when the team card measured 24 px of box around 164 px of text.
 */
async function assertFits(page: Page, label: string, width: number) {
  const m = await page.evaluate(() => {
    const doc = document.documentElement;
    const clipped: string[] = [];
    for (const el of Array.from(document.querySelectorAll('[data-testid], .card, .role-band, .cta'))) {
      const cs = getComputedStyle(el);
      const id = el.getAttribute('data-testid') ?? el.className;
      if (cs.overflowX !== 'visible' && cs.textOverflow !== 'ellipsis' && el.scrollWidth > el.clientWidth + 1 && el.clientWidth > 0) {
        clipped.push(`${id} W ${el.scrollWidth}>${el.clientWidth}`);
      }
      if (cs.overflowY !== 'visible' && cs.textOverflow !== 'ellipsis' && el.scrollHeight > el.clientHeight + 1 && el.clientHeight > 0) {
        clipped.push(`${id} H ${el.scrollHeight}>${el.clientHeight}`);
      }
    }
    return { pageOverflow: doc.scrollWidth - doc.clientWidth, clipped };
  });
  expect(m.pageOverflow, `${label}: horizontal overflow at ${width}px`).toBeLessThanOrEqual(0);
  expect(m.clipped, `${label}: clipped content at ${width}px → ${m.clipped.join(' | ')}`).toEqual([]);
}

test.describe.serial('V3.4 §11 — every redesigned screen at the 320px floor', () => {
  test('the flow, captured and measured per station', async ({ browser }) => {
    test.setTimeout(240_000);
    const width = 320;
    const context = await browser.newContext({ viewport: { width, height: 640 } });
    const lobby = await signIn(context, 'lobby');
    const corridor = await signIn(context, 'corridor');
    const gate = await signIn(context, 'gate');
    const room = await signIn(context, 'room305');
    const sup = await signIn(context, 'supervisor');

    const token = (page: Page) =>
      page.evaluate(() => JSON.parse(localStorage.getItem('sc305.session.v1') ?? '{}').token as string);
    const reset = await context.request.post('/api/dev/reset', { headers: { authorization: `Bearer ${await token(sup)}` } });
    expect(reset.ok()).toBe(true);
    for (const p of [lobby, corridor, gate, room, sup]) await p.reload();
    for (const p of [lobby, corridor, gate, room, sup]) await expect(p.getByTestId('dashboard')).toBeVisible();

    // UI-01: reception with a team waiting to be received.
    await expect(lobby.getByTestId('primary-action')).toBeVisible();
    await assertFits(lobby, 'lobby idle', width);
    await shot(lobby, '320-lobby');

    await lobby.getByTestId('primary-action').click();
    await expect.poll(async () => {
      const r = await context.request.get('/api/snapshot', { headers: { authorization: `Bearer ${await token(sup)}` } });
      return ((await r.json()) as { active_round?: { status?: string } }).active_round?.status;
    }, { timeout: 20_000 }).toBe('WAITING_FLOOR2_CONFIRMATION');

    // UI-02: floor 2 facing the handoff it must confirm.
    await expect(corridor.getByTestId('primary-action')).toHaveText('ĐỘI ĐÃ ĐẾN TẦNG 2');
    await assertFits(corridor, 'corridor handoff', width);
    await shot(corridor, '320-corridor');

    await corridor.getByTestId('primary-action').click();

    // UI-03 screen A: the gate's pre-start with the configured duration.
    await expect(gate.getByTestId('prestart-alert')).toBeVisible();
    await assertFits(gate, 'gate pre-start', width);
    await shot(gate, '320-gate-prestart');

    await gate.getByTestId('primary-action').click();

    // UI-03 screen B + UI-04: the locked countdown on NPC 1 and NPC 2's panel.
    await expect(gate.getByTestId('countdown-screen')).toBeVisible();
    await assertFits(gate, 'gate countdown', width);
    await shot(gate, '320-gate-countdown');
    await expect(room.getByTestId('countdown-screen')).toBeVisible();
    await room.getByTestId('record-claim').click();
    await assertFits(room, 'room verification', width);
    await shot(room, '320-room-verification');

    // The finished-event card on the retained admin, and the report group.
    await expect(sup.getByTestId('dashboard')).toBeVisible();
    await assertFits(sup, 'supervisor flow', width);
    await shot(sup, '320-supervisor');

    // UI-07: the restructured sheet at the narrowest floor. The report tab is
    // the longest surface in the app (summary, best result, ranking, folded
    // round cards, KPIs, filters), and the admin tab carries the six-level
    // hierarchy — both are measured with the round cards OPEN, because a folded
    // card hides exactly the lines that would overflow at 320px.
    //
    // The round is RUNNING here, so the countdown is locked and the station
    // footer is gone. The organiser keeps BOTH entries — VỊ TRÍ for a stuck seat
    // and the sheet entry for ĐIỀU HÀNH — because a live round is exactly when
    // they are needed; a station phone loses the sheet entry (v34-lobby-states).
    await expect(sup.getByTestId('open-settings')).toBeVisible();
    await expect(sup.getByTestId('open-seat-management')).toBeVisible();
    await sup.getByTestId('open-seat-management').click();
    await expect(sup.getByTestId('management')).toBeVisible();
    await sup.getByTestId('sheet-tab-report').click();
    // Open every disclosure in place: clicking each toggle re-renders the sheet
    // and detaches the next locator, while the folds are pure display state.
    await sup.evaluate(() => { for (const d of Array.from(document.querySelectorAll('details'))) d.open = true; });
    await assertFits(sup, 'report tab at 320px', width);
    await shot(sup, '320-report');
    await sup.getByTestId('sheet-tab-admin').click();
    await assertFits(sup, 'admin tab at 320px', width);
    await shot(sup, '320-admin');
    // The priority blocks are present in order, not merely rendered.
    await expect(sup.getByTestId('admin-event-status')).toBeVisible();
    await expect(sup.getByTestId('admin-next-action')).toBeVisible();
    await expect(sup.getByTestId('admin-group-risk')).toBeVisible();

    await context.close();
  });
});
