import { unlockAdmin } from './lib/admin';
import { expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { assertActionReachable, assertReadable, countSentences, shot } from './lib/visual';

/**
 * V3.4 §2 (UI-02) — NHÂN SỰ 02 · TẦNG 2, the floor-2 handoff.
 *
 * The rewrite of `CorridorStage` survived the interrupted sessions, but nothing
 * proved the half the brief cares about: what the phone shows AFTER its press
 * lands. These cases drive the real LOBBY→CORRIDOR workflow on the dev engine and
 * assert the properties the brief names, each one against the server's own
 * timestamp rather than a local impression:
 *
 *   · the arrival press is offered only while the flow is in the handoff window,
 *     and only to this role;
 *   · a write that has not been acknowledged reads as pending, never as confirmed,
 *     and cannot be duplicated from the UI;
 *   · once PostgreSQL has the stamp, the actionable CTA is gone and a compact
 *     read-only summary states "ĐÃ XÁC NHẬN ĐỘI ĐẾN TẦNG 2" and that NPC 1 owns
 *     the next step;
 *   · this phone never runs its own clock: before START it shows duration only,
 *     after START it shows the same shared countdown digits as every other phone;
 *   · one sentence, one place — "ĐỘI CHƠI SẮP BẮT ĐẦU" is not repeated across
 *     cards.
 */

type Phone = 'lobby' | 'corridor' | 'gate' | 'room305' | 'supervisor';

const ROLE_TAG: Record<Phone, string> = {
  lobby: '01',
  corridor: '02',
  gate: '03',
  room305: '04',
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

async function phone(browser: Browser, which: Phone) {
  const context = await browser.newContext();
  return { context, page: await signIn(context, which) };
}

const tokenOf = (page: Page) =>
  page.evaluate(() => JSON.parse(localStorage.getItem('sc305.session.v1') ?? '{}').token as string);

test.describe.serial('V3.4 §2 — NHÂN SỰ 02 handoff, confirmation and the read-only after', () => {
  test('the nine states on one phone, driven by the real lobby', async ({ browser }) => {
    test.setTimeout(300_000);
    const lobby = await phone(browser, 'lobby');
    const corridor = await phone(browser, 'corridor');
    const gate = await phone(browser, 'gate');
    const room = await phone(browser, 'room305');
    const sup = await phone(browser, 'supervisor');
    const pages = [lobby.page, corridor.page, gate.page, room.page, sup.page];

    const reset = await sup.context.request.post('/api/dev/reset', { headers: { authorization: `Bearer ${await tokenOf(sup.page)}` } });
    expect(reset.ok()).toBe(true);
    for (const p of pages) await p.reload();
    for (const p of pages) await expect(p.getByTestId('dashboard')).toBeVisible();

    const snapshot = async () => {
      const res = await sup.context.request.get('/api/snapshot', { headers: { authorization: `Bearer ${await tokenOf(sup.page)}` } });
      return (await res.json()) as {
        active_round?: {
          team_number?: number; status?: string; floor2_confirmed_at?: number | null;
          floor2_confirmed_by_role?: string | null; floor2_bypassed_at?: number | null;
          game_started_at?: number | null; deadline_at?: number | null;
        } | null;
        log?: { action: string; team_number: number | null }[];
      };
    };

    /* ------------------------------------------------ 1. no incoming team */
    await expect(corridor.page.getByTestId('r02-identity')).toBeVisible();
    await expect(corridor.page.getByTestId('r02-role')).toHaveText('NHÂN SỰ 02');
    await expect(corridor.page.getByTestId('r02-team-stage')).toHaveText('ĐỘI #001');
    await expect(corridor.page.getByTestId('r02-handoff-badge')).toContainText('CHƯA CÓ ĐỘI ĐƯỢC BÀN GIAO');
    await expect(corridor.page.getByTestId('r02-handoff-badge')).toHaveAttribute('data-state', 'none');
    // Nothing to press: the lock names who owns the step, and no arrival CTA exists.
    await expect(corridor.page.getByTestId('waiting-state')).toContainText('ĐANG CHỜ TIẾP NHẬN ĐỘI CHƠI');
    await expect(corridor.page.getByTestId('primary-action')).toHaveCount(0);
    await expect(corridor.page.getByTestId('r02-instruction')).toHaveCount(0);
    await assertReadable(corridor.page, 'corridor: no team');
    await shot(corridor.page, 'r02-1-no-team');

    /* ------------------------------------ 2. team handed off by the lobby */
    await lobby.page.getByTestId('primary-action').click();
    await expect.poll(async () => (await snapshot()).active_round?.status, { timeout: 20_000 }).toBe('WAITING_FLOOR2_CONFIRMATION');
    // V3.4.1: the heading names the team and the badge is the state — the old screen
    // said "đang lên tầng 2" in the heading, the badge, the status line and the
    // requirement sentence, four times inside one viewport.
    await expect(corridor.page.getByTestId('r02-team-stage')).toHaveText('ĐỘI #001');
    await expect(corridor.page.getByTestId('r02-handoff-badge')).toHaveAttribute('data-state', 'incoming');
    await expect(corridor.page.getByTestId('r02-handoff-badge')).toContainText('ĐỘI ĐANG LÊN TẦNG 2');
    await expect(corridor.page.getByTestId('primary-action')).toHaveText('ĐỘI ĐÃ ĐẾN TẦNG 2');
    // The physical precondition is stated once, as the press's own hint.
    await expect(corridor.page.getByTestId('primary-hint')).toHaveText('Chỉ xác nhận khi đội đã có mặt tại tầng 2.');
    // …and no second instruction block repeats it while the press is available.
    await expect(corridor.page.getByTestId('r02-instruction')).toHaveCount(0);
    // Compact duration only: this role never owns a running clock.
    await expect(corridor.page.getByTestId('r02-timer-label')).toHaveText('CHƯA TÍNH GIỜ');
    await expect(corridor.page.getByTestId('r02-timer-value')).toHaveText('05:00');
    await expect(corridor.page.getByTestId('countdown-screen')).toHaveCount(0);
    await assertReadable(corridor.page, 'corridor: incoming');
    await assertActionReachable(corridor.page, 'corridor: incoming');
    await shot(corridor.page, 'r02-2-incoming');

    /* ------------------------- 3. confirmation pending, then 4. confirmed */
    // Two properties, both proven by outcomes rather than by catching a transient:
    //
    //  · the screen never advances ahead of the authority. The DOM and the server
    //    are sampled together until the stamp exists; if the summary ever shows
    //    while the stored `floor2_confirmed_at` is still null, that is the bug.
    //  · a double tap cannot become two writes. The control disables itself while
    //    the first write is unacknowledged, so the audit trail must hold exactly
    //    one CONFIRM_FLOOR2 row for this round.
    await expect(corridor.page.getByTestId('r02-handoff-summary')).toHaveCount(0);
    expect((await snapshot()).active_round?.floor2_confirmed_at).toBeNull();
    await corridor.page.getByTestId('primary-action').dblclick();

    let sawPrematureSummary = false;
    for (let i = 0; i < 60; i++) {
      const stamped = (await snapshot()).active_round?.floor2_confirmed_at !== null;
      const shown = await corridor.page.getByTestId('r02-handoff-summary').isVisible();
      if (shown && !stamped) sawPrematureSummary = true;
      if (stamped && shown) break;
      await corridor.page.waitForTimeout(250);
    }
    expect(sawPrematureSummary, 'the summary appeared before the server had the stamp').toBe(false);

    expect((await snapshot()).active_round?.floor2_confirmed_by_role).toBe('CORRIDOR');
    await expect(corridor.page.getByTestId('r02-handoff-summary')).toBeVisible();
    await expect(corridor.page.getByTestId('r02-confirmed')).toHaveText('ĐÃ XÁC NHẬN ĐỘI ĐẾN TẦNG 2');
    await expect(corridor.page.getByTestId('r02-hand-who')).toHaveText('CHỜ NHÂN SỰ 03');
    await expect(corridor.page.getByTestId('r02-confirmed-at')).toContainText('Máy chủ ghi nhận lúc');
    // The arrival CTA is gone, not greyed: there is nothing left to press here.
    await expect(corridor.page.getByTestId('primary-action')).toHaveCount(0);
    await expect(corridor.page.getByTestId('waiting-state')).toHaveCount(0);
    await expect(corridor.page.getByTestId('r02-instruction')).toHaveCount(0);
    await expect(corridor.page.getByTestId('r02-team-stage')).toHaveText('ĐỘI #001');
    await expect(corridor.page.getByTestId('r02-handoff-badge')).toHaveAttribute('data-state', 'confirmed');
    // The route moves from the authoritative stamps, not from this phone's press.
    await expect(corridor.page.getByTestId('journey-strip')).toHaveAttribute('data-focus', '2');
    await assertReadable(corridor.page, 'corridor: confirmed');
    await assertActionReachable(corridor.page, 'corridor: confirmed');
    await shot(corridor.page, 'r02-3-confirmed');

    // The duplicate-submission proof: one double tap, one row in the audit trail,
    // and after the stamp there is no control left to tap a third time.
    const confirmRows = (await snapshot()).log?.filter((l) => l.action === 'CONFIRM_FLOOR2') ?? [];
    expect(confirmRows.length).toBe(1);

    /* ------------------------------------------- 5. NPC 1 preparing */
    // One sentence, one place: the route caption carries it, no card repeats it.
    expect(await countSentences(corridor.page, 'ĐỘI CHƠI SẮP BẮT ĐẦU')).toBeLessThanOrEqual(1);
    await expect(corridor.page.getByTestId('alert-PRESTART')).toHaveCount(0);

    /* ------------------------------ 6. lost connection, then reconnection */
    // Measured while this station's own screen is still on screen: the chip, the
    // identity band and the handoff badge all have to switch to the transport
    // truth, and no press may be offered into a state the phone cannot read.
    await corridor.page.context().setOffline(true);
    for (let i = 0; i < 40; i++) {
      const s = await corridor.page.getByTestId('connection').getAttribute('data-status');
      if (s !== 'CONNECTED') break;
      await corridor.page.waitForTimeout(1_000);
    }
    await expect(corridor.page.getByTestId('connection')).not.toHaveAttribute('data-status', 'CONNECTED', { timeout: 5_000 });
    await expect(corridor.page.getByTestId('sync-retry')).toBeVisible();
    await expect(corridor.page.getByTestId('r02-identity')).toHaveAttribute('data-sync', 'broken');
    await expect(corridor.page.getByTestId('r02-handoff-badge')).toHaveAttribute('data-state', 'error');
    await expect(corridor.page.getByTestId('r02-handoff-badge')).toContainText('KHÔNG ĐỌC ĐƯỢC MÁY CHỦ');
    // A read failure does not release the seat: the binding badge keeps its true
    // word AND its true colour, so no status is carried by colour alone.
    await expect(corridor.page.getByTestId('r02-binding-state')).toHaveAttribute('data-tone', 'confirmed');
    await expect(corridor.page.getByTestId('r02-binding-state')).toContainText('ĐÃ GẮN VỊ TRÍ');
    await expect(corridor.page.getByTestId('r02-instruction')).toContainText('THỬ LẠI');
    await assertReadable(corridor.page, 'corridor: offline');
    await shot(corridor.page, 'r02-5-offline');
    await corridor.page.context().setOffline(false);
    await expect(corridor.page.getByTestId('connection')).toHaveAttribute('data-status', 'CONNECTED', { timeout: 40_000 });
    await expect(corridor.page.getByTestId('r02-identity')).toHaveAttribute('data-sync', 'live');
    await expect(corridor.page.getByTestId('r02-handoff-badge')).toHaveAttribute('data-state', 'confirmed');

    /* ------------------------------------- 7. NPC 1 countdown running */
    await gate.page.getByTestId('primary-action').click();
    await expect(corridor.page.getByTestId('countdown-screen')).toBeVisible({ timeout: 20_000 });
    // A station with nothing to press during the game is switched to the wall
    // display; close it so this test measures the phone, not the projector.
    await corridor.page.keyboard.press('Escape');
    await expect(corridor.page.getByTestId('countdown-screen')).toBeVisible();
    // The shared official timer, not a CORRIDOR copy: the same digits the phone
    // that started the round is showing, read from the same deadline.
    const gateClock = (await gate.page.getByTestId('hero-clock').textContent())?.trim();
    const corridorClock = (await corridor.page.getByTestId('hero-clock').textContent())?.trim();
    expect(corridorClock).toMatch(/^0[45]:\d\d$/);
    expect(Math.abs(Number(gateClock?.slice(3, 5)) - Number(corridorClock?.slice(3, 5)))).toBeLessThanOrEqual(1);
    // View-only: no clock control of any kind on this phone while the round runs.
    await expect(corridor.page.getByTestId('primary-action')).toHaveCount(0);
    await expect(corridor.page.getByTestId('r02-timer-info')).toHaveCount(0);
    await assertReadable(corridor.page, 'corridor: running');
    await shot(corridor.page, 'r02-4-running');

    /* ------------------------------------- 8. event ended */
    // Close the round honestly first, or END_EVENT is refused over an open floor:
    // NPC 1's guarded exit, then the two physical reset owners, then finalize.
    await gate.page.getByTestId('emergency-open').click();
    await gate.page.getByTestId('emergency-reason').fill('Hết ca');
    await gate.page.getByTestId('emergency-confirm').click();
    await expect.poll(async () => (await snapshot()).active_round?.status, { timeout: 20_000 }).toBe('EXIT_CONFIRMED');
    await gate.page.getByTestId('primary-action').click();
    await room.page.getByTestId('primary-action').click();
    await expect(gate.page.getByTestId('primary-action')).toHaveText('XÁC NHẬN SẴN SÀNG', { timeout: 20_000 });
    await gate.page.getByTestId('primary-action').click();
    await sup.page.getByTestId('open-settings').click();
    await sup.page.getByTestId('sheet-tab-admin').click();
    await sup.page.getByTestId('close-reason').fill('Kết ca');
    await sup.page.getByTestId('admin-end').click();
    await expect(corridor.page.getByTestId('event-ended-card')).toBeVisible({ timeout: 20_000 });
    await expect(corridor.page.getByTestId('primary-action')).toHaveCount(0);
    await assertReadable(corridor.page, 'corridor: ended');
    await shot(corridor.page, 'r02-6-ended');

    for (const { context } of [lobby, corridor, gate, room, sup]) await context.close();
  });

  test('the handoff screen is readable at every phone width', async ({ browser }) => {
    test.setTimeout(240_000);
    // One supervisor for the whole sweep, and a fresh event before every width:
    // the lobby's reception press only exists with no round open, so an
    // unreached iteration would otherwise wait on a control that cannot appear.
    const sup = await phone(browser, 'supervisor');
    const reset = async () => {
      const r = await sup.context.request.post('/api/dev/reset', { headers: { authorization: `Bearer ${await tokenOf(sup.page)}` } });
      expect(r.ok()).toBe(true);
    };

    for (const width of [320, 360, 375, 390, 414, 430]) {
      await reset();
      const context = await browser.newContext({ viewport: { width, height: 640 } });
      const lobby = await signIn(context, 'lobby');
      const corridor = await signIn(context, 'corridor');
      await assertReadable(corridor, `corridor idle at ${width}px`);
      await lobby.getByTestId('primary-action').click();
      await expect(corridor.getByTestId('primary-action')).toHaveText('ĐỘI ĐÃ ĐẾN TẦNG 2', { timeout: 20_000 });
      await assertReadable(corridor, `corridor incoming at ${width}px`);
      await assertActionReachable(corridor, `corridor incoming at ${width}px`);
      // The one thing this role must not do: run its own clock.
      await expect(corridor.getByTestId('countdown-screen')).toHaveCount(0);
      if (width === 320) await shot(corridor, 'r02-320');
      await context.close();
    }
    await sup.context.close();
  });
});
