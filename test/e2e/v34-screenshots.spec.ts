import { unlockAdmin } from './lib/admin';
import { expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { mkdirSync } from 'node:fs';

type Phone = 'lobby' | 'corridor' | 'gate' | 'room305' | 'supervisor';

const ROLE_TAG: Record<Phone, string> = {
  lobby: '01',
  corridor: '02',
  gate: '03',
  room305: '04',
  supervisor: 'TRỊ',
};

async function signIn(context: BrowserContext, phone: Phone): Promise<Page> {
  const page = await context.newPage();
  await page.goto(`/?station=${phone}`);
  if (phone === 'supervisor') await unlockAdmin(page);
  await expect(page.getByTestId('dashboard')).toBeVisible();
  await expect(page.getByTestId('role-tag')).toHaveText(ROLE_TAG[phone]);
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

/** Drives the shared dev engine forward through the presses the floor makes. */
async function supToken(sup: Page): Promise<string> {
  return sup.evaluate(() => JSON.parse(localStorage.getItem('sc305.session.v1') ?? '{}').token as string);
}

test.describe.serial('V3.4 §11 — rendered mobile states for visual QA', () => {
  test('captures the NPC2/NPC1 verification flow and checks 320…430 widths', async ({ browser }) => {
    test.setTimeout(240_000);
    const lobby = await phone(browser, 'lobby');
    const corridor = await phone(browser, 'corridor');
    const gate = await phone(browser, 'gate');
    const room = await phone(browser, 'room305');
    const sup = await phone(browser, 'supervisor');
    const pages = [lobby.page, corridor.page, gate.page, room.page, sup.page];

    // Clean event for the whole capture run.
    const res = await sup.context.request.post('/api/dev/reset', { headers: { authorization: `Bearer ${await supToken(sup.page)}` } });
    expect(res.ok()).toBe(true);
    for (const p of pages) await p.reload();
    for (const p of pages) await expect(p.getByTestId('dashboard')).toBeVisible();

    // Put a clock on the floor.
    await lobby.page.getByTestId('primary-action').click();
    await corridor.page.getByTestId('primary-action').click();
    await gate.page.getByTestId('primary-action').click();
    await expect(room.page.getByTestId('countdown-screen')).toBeVisible();

    // 1. NPC2 round running: countdown dominant, claim CTA offered.
    await shot(room.page, 'npc2-round-running');

    // The wall display in large-display mode over the same clock.
    await gate.page.getByTestId('countdown-big').click();
    await expect(gate.page.getByTestId('big-screen')).toBeVisible();
    await shot(gate.page, 'big-screen-running');
    await gate.page.keyboard.press('Escape');
    await expect(gate.page.getByTestId('big-screen')).toBeHidden();

    // 2. Completion report pending: the verification card with both decisions.
    await room.page.getByTestId('record-claim').click();
    await expect(room.page.getByTestId('verify-card-1')).toBeVisible();
    await shot(room.page, 'npc2-claim-pending');

    // 3. Incorrect attempt: rejected row keeps its own timestamp.
    await room.page.getByTestId('attempt-invalid-1').click();
    await expect(room.page.getByTestId('attempt-1')).toHaveAttribute('data-status', 'INVALID');
    await shot(room.page, 'npc2-attempt-incorrect');

    // Second claim, then the two-press finalisation.
    await room.page.getByTestId('record-claim').click();
    await room.page.getByTestId('attempt-valid-2').click();
    await room.page.getByTestId('attempt-valid-2').click();
    await expect.poll(async () => {
      const r = await sup.context.request.get('/api/snapshot', { headers: { authorization: `Bearer ${await supToken(sup.page)}` } });
      return ((await r.json()) as { active_round?: { result?: string } }).active_round?.result;
    }, { timeout: 20_000 }).toBe('WON');

    // 4. Correct official result: milestone card, CTA gone.
    await expect(room.page.getByTestId('official-result')).toBeVisible();
    await expect(room.page.getByTestId('record-claim')).toHaveCount(0);
    await shot(room.page, 'npc2-official-result');

    // 5. NPC2 waiting for team exit — the same read-only surface one beat later.
    await expect(room.page.getByTestId('official-result-wait')).toContainText('Đang chờ Nhân sự 03 xác nhận đội rời tầng 3.');
    await shot(room.page, 'npc2-waiting-team-exit');

    // 6. NPC1 awaiting the exit confirmation: hand-off card + guarded CTA.
    await expect(gate.page.getByTestId('npc1-handoff')).toBeVisible();
    await expect(gate.page.getByTestId('primary-action')).toHaveText('ĐỘI ĐÃ RỜI TẦNG 3');
    await shot(gate.page, 'npc1-awaiting-exit');

    // §11 width sweep — while the round is still in the exit-waiting lock, the
    // two new surfaces must fit every phone without sideways overflow.
    for (const width of [320, 360, 375, 390, 414, 430]) {
      const context = await browser.newContext({ viewport: { width, height: 640 } });
      const npc2 = await signIn(context, 'room305');
      await expect(npc2.getByTestId('official-result')).toBeVisible();
      const overflow2 = await npc2.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      );
      expect(overflow2, `npc2 finalized overflows at ${width}px by ${overflow2}px`).toBeLessThanOrEqual(0);
      if (width === 320) await shot(npc2, 'npc2-official-result-320');
      const npc1 = await signIn(context, 'gate');
      await expect(npc1.getByTestId('npc1-handoff')).toBeVisible();
      const overflow1 = await npc1.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      );
      expect(overflow1, `npc1 hand-off overflows at ${width}px by ${overflow1}px`).toBeLessThanOrEqual(0);
      if (width === 320) await shot(npc1, 'npc1-awaiting-exit-320');
      await context.close();
    }

    // 7. NPC1 after the successful exit confirmation (reset flow).
    await gate.page.getByTestId('primary-action').click();
    await gate.page.getByTestId('primary-action').click();
    await expect.poll(async () => {
      const r = await sup.context.request.get('/api/snapshot', { headers: { authorization: `Bearer ${await supToken(sup.page)}` } });
      return ((await r.json()) as { active_round?: { status?: string } }).active_round?.status;
    }, { timeout: 20_000 }).toBe('EXIT_CONFIRMED');
    await shot(gate.page, 'npc1-after-exit-confirmed');

    // 8. Disconnected / reconnecting: the chip names the real transport state.
    await room.page.context().setOffline(true);
    await expect(room.page.getByTestId('connection')).not.toHaveAttribute('data-status', 'CONNECTED', { timeout: 30_000 });
    await shot(room.page, 'disconnected-reconnecting');
    await room.page.context().setOffline(false);
    await expect(room.page.getByTestId('connection')).toHaveAttribute('data-status', 'CONNECTED', { timeout: 30_000 });

    for (const { context } of [lobby, corridor, gate, room, sup]) await context.close();
  });
});
