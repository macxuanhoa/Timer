import { expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test';
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
  await expect(page.getByTestId('dashboard')).toBeVisible();
  await expect(page.getByTestId('role-tag')).toHaveText(ROLE_TAG[which]);
  return page;
}

const shot = async (page: Page, name: string) => {
  mkdirSync('shots', { recursive: true });
  await page.screenshot({ path: `shots/v34-${name}.png` });
};

/** The only overflow measurement that matters on a phone: document scroll vs client width. */
async function assertFits(page: Page, label: string, width: number) {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow, `${label} overflows ${width}px by ${overflow}px`).toBeLessThanOrEqual(0);
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
    await expect(corridor.getByTestId('primary-action')).toHaveText('XÁC NHẬN ĐỘI ĐÃ ĐẾN TẦNG 2');
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

    await context.close();
  });
});
