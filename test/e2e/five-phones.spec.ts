import { expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test';

type Phone = 'lobby' | 'gate' | 'corridor' | 'room305' | 'supervisor';
const ROLE_TAG: Record<Phone, string> = {
  lobby: 'LOBBY',
  gate: 'NPC 1',
  corridor: 'NPC 2',
  room305: 'NPC 3',
  supervisor: 'SUP',
};

/**
 * The self-hosted engine has no Supabase to redeem an invitation against, so a
 * station link (`?station=lobby`) is its stand-in for the real `/i/<token>`.
 */
async function signIn(context: BrowserContext, phone: Phone): Promise<Page> {
  const page = await context.newPage();
  await page.goto(`/?station=${phone}`);
  await expect(page.getByTestId('dashboard')).toBeVisible();
  await expect(page.getByTestId('role-tag')).toHaveText(ROLE_TAG[phone]);
  await expect(page.getByTestId('connection')).toHaveAttribute('data-status', 'CONNECTED');
  return page;
}

async function phone(browser: Browser, which: Phone) {
  const context = await browser.newContext();
  return { context, page: await signIn(context, which) };
}

const primary = (page: Page) => page.getByTestId('primary-action');
const heroLabel = (page: Page) =>
  page.evaluate(() => document.querySelector('[data-testid="hero-label"]')?.textContent ?? '');
const teamStatus = (page: Page) =>
  page.evaluate(() => document.querySelector('[data-testid="team-status"]')?.textContent ?? '');

test.describe.serial('SCREAM CONTROL V2 — five phones, one event', () => {
  test.beforeAll(async ({ browser }) => {
    // Deterministic start: ask the dev engine for a brand new session, so a
    // reused dev server left over from an earlier run cannot bias the suite.
    const { context, page } = await phone(browser, 'supervisor');
    const token = await page.evaluate(() => JSON.parse(localStorage.getItem('sc305.session.v1') ?? '{}').token as string);
    const res = await context.request.post('/api/dev/reset', { headers: { authorization: `Bearer ${token}` } });
    expect(res.ok()).toBe(true);
    await context.close();
  });

  test('runs a complete round and ranks the result', async ({ browser }) => {
    const lobby = await phone(browser, 'lobby');
    const gate = await phone(browser, 'gate');
    const corridor = await phone(browser, 'corridor');
    const room = await phone(browser, 'room305');
    const sup = await phone(browser, 'supervisor');

    // §5/§7 before the first team: LOBBY owns the start, everyone else waits
    await expect(lobby.page.getByTestId('event-remaining')).toHaveText('01:30:00'); // frozen until a team goes up
    await expect(primary(lobby.page)).toHaveText('CHO ĐỘI LÊN');
    await expect(sup.page.getByTestId('waiting-state')).toContainText('CHƯA CHẠY 90:00');
    await expect(gate.page.getByTestId('waiting-state')).toContainText('CHỜ LOBBY GỌI ĐỘI');

    await lobby.page.getByTestId('team-edit').click();
    await lobby.page.getByTestId('team-name').fill('Ma Tro');
    await primary(lobby.page).click();
    await expect(gate.page.getByTestId('event-remaining')).not.toHaveText('01:30:00'); // the timeline now runs

    // §5 the hero shows no number while the team walks up: only the 5:00 window is a clock
    await expect(gate.page.getByTestId('hero-label')).toHaveText('CHƯA TÍNH GIỜ');
    await expect(room.page.getByTestId('hero-label')).toHaveText('CHƯA TÍNH GIỜ');

    // The journey strip shows the walk: LOBBY owns the first press, then the team is
    // reported at the third-floor entrance and GATE owns the clock.
    await expect(lobby.page.getByTestId('journey-strip')).toHaveAttribute('data-movement', 'up');
    // The area the guests are walking into leads: the gate tile carries the light.
    await expect(lobby.page.getByTestId('journey-node-gate')).toHaveAttribute('data-lead', '1');
    await expect(primary(lobby.page)).toHaveText('ĐÃ LÊN TẦNG 3');
    await primary(lobby.page).click();
    await expect(lobby.page.getByTestId('waiting-state')).toContainText('ĐỘI ĐANG Ở CỬA VÀO TẦNG 3');
    await expect(gate.page.getByTestId('journey-strip')).toHaveAttribute('data-position', '1');
    await expect(gate.page.getByTestId('journey-status')).toContainText('Đội đã lên tới cửa vào tầng 3');

    await expect(primary(gate.page)).toHaveText('BẮT ĐẦU');
    await primary(gate.page).click();
    await expect(gate.page.getByTestId('hero-clock')).toHaveAttribute('data-mode', 'GAME');
    await expect(gate.page.getByTestId('hero-clock')).toHaveText(/^0[45]:\d\d\.\d\d$/);

    await expect(primary(corridor.page)).toHaveText('ĐÃ SETUP XONG');
    await primary(corridor.page).click();
    await expect(room.page.getByTestId('journey-strip')).toHaveAttribute('data-position', '2');
    await expect(primary(room.page)).toHaveText('ĐÃ ĐẾN 305');
    await primary(room.page).click();
    await expect(room.page.getByTestId('journey-strip')).toHaveAttribute('data-position', '3');
    await expect(primary(room.page)).toHaveText('XÁC NHẬN HOÀN THÀNH');
    await primary(room.page).click();
    await expect(room.page.getByTestId('journey-node-room')).toHaveAttribute('data-state', 'lead');
    await expect(room.page.getByTestId('progress-line')).toContainText('Trận đồ đã hoàn thành');

    // The floor map opens from any phone and shows the real press times.
    await room.page.getByTestId('journey-status').click();
    await expect(room.page.getByTestId('journey-board')).toBeVisible();
    await expect(room.page.getByTestId('journey-where')).toContainText('PHÒNG 305');
    await expect(room.page.getByTestId('journey-stop-room')).toHaveAttribute('data-state', 'lead');
    await room.page.getByTestId('journey-close').click();
    await expect(room.page.getByTestId('journey-board')).toBeHidden();

    // §1 confirming the puzzle does not stop the official clock
    await expect(room.page.getByTestId('hero-clock')).toHaveAttribute('data-mode', 'GAME');
    await expect(primary(room.page)).toHaveText('ĐỘI RỜI PHÒNG 305');
    await primary(room.page).click();
    await expect(gate.page.getByTestId('journey-strip')).toHaveAttribute('data-movement', 'down');
    await expect(gate.page.getByTestId('journey-node-gate')).toHaveAttribute('data-lead', '1');
    await expect(primary(gate.page)).toHaveText('KHÁCH ĐÃ RA — CHỐT GIỜ');
    await primary(gate.page).click();
    await expect(lobby.page.getByTestId('journey-strip')).toHaveAttribute('data-position', '1');

    // §3 reset tasks activate immediately and run concurrently
    await expect(primary(corridor.page)).toHaveText('ĐÃ RESET XONG');
    await expect(primary(room.page)).toHaveText('ĐÃ RESET XONG');
    await expect(gate.page.getByTestId('waiting-state')).toContainText('CHỜ RESET HOÀN TẤT');
    await primary(corridor.page).click();

    // §5 live NPC readiness, inspected on another phone through “Xem thêm”
    await lobby.page.getByTestId('open-details').click();
    await lobby.page.getByTestId('section-npc').locator('summary').click();
    await expect(lobby.page.getByTestId('npc-CORRIDOR')).toContainText('XONG');
    await expect(lobby.page.getByTestId('npc-ROOM305')).toContainText('ĐANG LÀM');
    await lobby.page.getByTestId('close-details').click();

    await primary(room.page).click();
    await expect(primary(gate.page)).toHaveText('XÁC NHẬN SẴN SÀNG');
    await primary(gate.page).click();

    // §3 the lobby may call the next team as soon as the area is cleared
    await expect(primary(lobby.page)).toHaveText('CHO ĐỘI LÊN');
    await expect(gate.page.getByTestId('hero-label')).toHaveText('CHƯA TÍNH GIỜ');
    // …and the route is back at tầng 1, where LOBBY presses first.
    await expect(lobby.page.getByTestId('journey-strip')).toHaveAttribute('data-position', '0');
    await expect(lobby.page.getByTestId('journey-status')).toContainText('Sẵn sàng gọi đội');

    // §8 the leaderboard ranks the finished, successful team
    await lobby.page.getByTestId('open-details').click();
    const sheet = lobby.page.getByTestId('details-sheet');
    await expect(sheet).toBeVisible();
    await lobby.page.getByTestId('section-leaderboard').locator('summary').click();
    await expect(lobby.page.getByTestId('leaderboard-table')).toContainText('#001');
    await lobby.page.getByTestId('section-rounds').locator('summary').click();
    await expect(lobby.page.getByTestId('round-detail-1')).toContainText('Điểm chính thức');
    await expect(lobby.page.getByTestId('round-detail-1')).toContainText('THÀNH CÔNG');
    await expect(lobby.page.getByTestId('round-detail-1')).toContainText('Reset phòng 305');
    await lobby.page.getByTestId('section-npc').locator('summary').click();
    await expect(lobby.page.getByTestId('npc-ROOM305')).toContainText('—'); // idle again
    await expect(lobby.page.getByTestId('npc-SUPERVISOR')).toBeVisible();
    await lobby.page.getByTestId('section-history').locator('summary').click();
    await expect(lobby.page.getByTestId('history')).toContainText('Chốt giờ đội #001');
    await expect(lobby.page.getByTestId('history')).toContainText('ROOM305');
    await lobby.page.getByTestId('close-details').click();
    await expect(sheet).toBeHidden();

    for (const { context } of [lobby, gate, corridor, room, sup]) await context.close();
  });

  test('16. “Xem thêm” never pauses or disturbs the live dashboard', async ({ browser }) => {
    const gate = await phone(browser, 'gate');
    const lobby = await phone(browser, 'lobby');

    await gate.page.getByTestId('open-details').click();
    const sheet = gate.page.getByTestId('details-sheet');
    await expect(sheet).toBeVisible();

    // the event clock in the sheet header keeps counting while it is open
    const header = gate.page.getByTestId('details-sheet').locator('header');
    const before = await header.innerText();
    await expect.poll(() => header.innerText(), { timeout: 12_000 }).not.toBe(before);

    // another phone advances the shared state; the covered dashboard still updates
    const statusBefore = await teamStatus(gate.page);
    expect(statusBefore).toContain('Chờ gọi đội');
    await primary(lobby.page).click(); // CHO ĐỘI LÊN
    await expect.poll(() => teamStatus(gate.page), { timeout: 10_000 }).not.toBe(statusBefore);
    expect(await teamStatus(gate.page)).toContain('Đang lên tầng');
    expect(await heroLabel(gate.page)).toBe('CHƯA TÍNH GIỜ');

    // closing returns instantly to the current live dashboard, no reload
    await gate.page.getByTestId('close-details').click();
    await expect(sheet).toBeHidden();
    await expect(gate.page.getByTestId('dashboard')).toBeVisible();
    await expect(gate.page.getByTestId('primary-action')).toHaveText('BẮT ĐẦU');
    await expect(gate.page.getByTestId('journey-strip')).toHaveAttribute('data-movement', 'up');

    await lobby.context.close();
    await gate.context.close();
  });

  test('11. the game clock expiring is an alarm, not an automatic clear', async ({ browser }) => {
    const gate = await phone(browser, 'gate');
    const corridor = await phone(browser, 'corridor');
    const room = await phone(browser, 'room305');
    const sup = await phone(browser, 'supervisor');
    const token = await sup.page.evaluate(() => JSON.parse(localStorage.getItem('sc305.session.v1') ?? '{}').token as string);

    // a team is already upstairs (dispatched in the previous case)
    await expect(primary(gate.page)).toHaveText('BẮT ĐẦU');
    await primary(gate.page).click();
    await expect(gate.page.getByTestId('hero-clock')).toHaveAttribute('data-mode', 'GAME');

    // let the 5-minute limit lapse without anyone pressing anything
    await sup.context.request.post('/api/dev/clock', {
      data: { advance_ms: 5 * 60 * 1000 + 10_000 },
      headers: { authorization: `Bearer ${token}` },
    });
    await expect(gate.page.getByTestId('hero-clock')).toHaveAttribute('data-mode', 'GAME_OVERTIME');
    await expect(gate.page.getByTestId('hero-label')).toHaveText('QUÁ GIỜ');
    await expect(gate.page.getByTestId('overtime-flag')).toHaveText('OVERTIME');
    await expect(primary(gate.page)).toHaveText('KHÁCH ĐÃ RA — CHỐT GIỜ'); // still GATE's call

    await primary(gate.page).click();
    await expect(gate.page.getByTestId('hero-label')).toHaveText('CHƯA TÍNH GIỜ');
    await expect(primary(corridor.page)).toHaveText('ĐÃ RESET XONG');
    await expect(primary(room.page)).toHaveText('ĐÃ RESET XONG');
    await primary(corridor.page).click();
    await primary(room.page).click();
    await expect(primary(gate.page)).toHaveText('XÁC NHẬN SẴN SÀNG');
    await primary(gate.page).click();
    await expect(gate.page.getByTestId('hero-label')).toHaveText('CHƯA TÍNH GIỜ');

    for (const { context } of [gate, corridor, room, sup]) await context.close();
  });

  test('G03 / Scenario F. losing the network during STOP never fabricates a score', async ({ browser }) => {
    const lobby = await phone(browser, 'lobby');
    const gate = await phone(browser, 'gate');
    const sup = await phone(browser, 'supervisor');

    // The dev engine keeps one session; start a clean one so this case is
    // independent of the elapsed clock in earlier cases.
    const token = await sup.page.evaluate(() => JSON.parse(localStorage.getItem('sc305.session.v1') ?? '{}').token as string);
    const headers = { authorization: `Bearer ${token}` };
    expect((await sup.context.request.post('/api/dev/reset', { headers })).ok()).toBe(true);
    await lobby.page.reload();
    await gate.page.reload();
    await sup.page.reload();

    // The first dispatch opens the 90:00 — there is no separate start button.
    await expect(primary(lobby.page)).toHaveText('CHO ĐỘI LÊN');
    await primary(lobby.page).click();
    await expect(primary(gate.page)).toHaveText('BẮT ĐẦU');
    await primary(gate.page).click();
    await expect(gate.page.getByTestId('hero-clock')).toHaveAttribute('data-mode', 'GAME');

    // GATE walks into dead Wi-Fi and presses STOP
    await gate.context.setOffline(true);
    await primary(gate.page).click();
    await expect(gate.page.getByTestId('message')).toContainText(/XÁC MINH|CHƯA ĐƯỢC GHI NHẬN|MẤT KẾT NỐI/, { timeout: 20_000 });
    await expect(gate.page.getByTestId('hero-clock')).toHaveAttribute('data-mode', 'GAME'); // clock still running
    const unread = await (await sup.context.request.get('/api/snapshot', { headers })).json();
    expect(unread.active_round.game_stopped_at).toBeNull(); // no invented score on the server

    // back online: the same press is applied once, and only once
    await gate.context.setOffline(false);
    await expect(gate.page.getByTestId('connection')).not.toHaveAttribute('data-status', 'OFFLINE', { timeout: 20_000 });
    await primary(gate.page).click();
    await expect(gate.page.getByTestId('hero-label')).toHaveText('CHƯA TÍNH GIỜ');
    const after = await (await sup.context.request.get('/api/snapshot', { headers })).json();
    expect(after.active_round.game_stopped_at).not.toBeNull();
    const stops = after.log.filter((l: { action: string }) => l.action === 'GAME_STOP').length;
    expect(stops).toBeGreaterThanOrEqual(1);

    for (const { context } of [lobby, gate, sup]) await context.close();
  });

  test('17. every dashboard fits 360px without horizontal scrolling', async ({ browser }) => {
    for (const which of ['lobby', 'gate', 'corridor', 'room305', 'supervisor'] as Phone[]) {
      const context = await browser.newContext({ viewport: { width: 360, height: 640 } });
      const page = await signIn(context, which);
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      );
      expect(overflow, `${which} overflows by ${overflow}px`).toBeLessThanOrEqual(0);

      await page.getByTestId('open-details').click();
      const sheetOverflow = await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      );
      expect(sheetOverflow, `${which} sheet overflows`).toBeLessThanOrEqual(0);
      await page.getByTestId('close-details').click();
      await context.close();
    }
  });

  test('9. the lobby is stopped from admitting a team near the cutoff', async ({ browser }) => {
    const sup = await phone(browser, 'supervisor');
    const lobby = await phone(browser, 'lobby');
    const gate = await phone(browser, 'gate');
    const corridor = await phone(browser, 'corridor');
    const room = await phone(browser, 'room305');

    // Start from a known-clean session, run one full round so the area is READY,
    // then jump the controlled clock to exactly 6 minutes before the deadline:
    // less than the 5-minute limit + 90s allowance.
    const token = await sup.page.evaluate(() => JSON.parse(localStorage.getItem('sc305.session.v1') ?? '{}').token as string);
    const headers = { authorization: `Bearer ${token}` };
    expect((await sup.context.request.post('/api/dev/reset', { headers })).ok()).toBe(true);
    await sup.page.reload();
    await lobby.page.reload();
    await expect(primary(lobby.page)).toHaveText('CHO ĐỘI LÊN');
    await primary(lobby.page).click();
    await expect(primary(gate.page)).toHaveText('BẮT ĐẦU');
    await primary(gate.page).click();
    await expect(primary(gate.page)).toHaveText('KHÁCH ĐÃ RA — CHỐT GIỜ');
    await primary(gate.page).click();
    await expect(primary(corridor.page)).toHaveText('ĐÃ RESET XONG');
    await primary(corridor.page).click();
    await primary(room.page).click();
    await expect(primary(gate.page)).toHaveText('XÁC NHẬN SẴN SÀNG');
    await primary(gate.page).click();
    await expect(primary(lobby.page)).toHaveText('CHO ĐỘI LÊN');

    const readSnapshot = async () =>
      (await (await sup.context.request.get('/api/snapshot', { headers })).json()) as {
        event: { event_started_at: number | null; config: { event_duration_ms: number } };
      };
    const live = await readSnapshot();
    expect(live.event.event_started_at).not.toBeNull();
    const pushed = await sup.context.request.post('/api/dev/clock', {
      data: { set_ms: (live.event.event_started_at as number) + live.event.config.event_duration_ms - 360_000 },
      headers,
    });
    expect(pushed.ok()).toBe(true);

    await expect(lobby.page.getByTestId('override-zone')).toContainText('SẮP KẾT THÚC — KHÔNG NHẬN ĐỘI MỚI');
    await expect(lobby.page.getByTestId('primary-action')).toHaveCount(0);
    await expect(sup.page.getByTestId('override-open')).toBeVisible();

    // an exceptional admission needs a typed reason and lands in the audit log
    await sup.page.getByTestId('override-open').click();
    await expect(sup.page.getByTestId('override-reason')).toBeVisible();
    await expect(sup.page.getByTestId('override-confirm')).toBeDisabled(); // no confirmation without a reason
    await sup.page.getByTestId('override-reason').fill('Da dat truoc');
    await sup.page.getByTestId('override-confirm').click();
    await expect(sup.page.getByTestId('hero-label')).toHaveText('CHƯA TÍNH GIỜ');

    await sup.page.getByTestId('open-details').click();
    await sup.page.getByTestId('section-admin').locator('summary').click();
    await expect(sup.page.getByTestId('management')).toBeVisible();
    await sup.page.getByTestId('close-details').click();

    for (const { context } of [lobby, sup, gate, corridor, room]) await context.close();
  });

  test('18. the wall display takes the lobby phone over for the 5-minute countdown', async ({ browser }) => {
    const sup = await phone(browser, 'supervisor');
    const lobby = await phone(browser, 'lobby');
    const gate = await phone(browser, 'gate');
    const token = await sup.page.evaluate(() => JSON.parse(localStorage.getItem('sc305.session.v1') ?? '{}').token as string);
    const headers = { authorization: `Bearer ${token}` };

    expect((await sup.context.request.post('/api/dev/reset', { headers })).ok()).toBe(true);
    await sup.page.reload();
    await lobby.page.reload();
    await gate.page.reload();
    await expect(primary(lobby.page)).toHaveText('CHO ĐỘI LÊN');
    await primary(lobby.page).click(); // the first dispatch opens the 90:00
    await expect(primary(gate.page)).toHaveText('BẮT ĐẦU');

    // Nobody touches the lobby phone: the 5-minute countdown becomes the whole screen.
    await primary(gate.page).click();
    const big = lobby.page.getByTestId('big-screen');
    await expect(big).toBeVisible();
    await expect(lobby.page.getByTestId('big-clock')).toHaveText(/^0[45]:\d\d$/);
    await expect(lobby.page.getByTestId('big-clock')).toHaveCSS('color', 'rgb(225, 54, 44)');
    const digitPx = await lobby.page.getByTestId('big-clock').evaluate((el) => parseFloat(getComputedStyle(el).fontSize));
    expect(digitPx).toBeGreaterThanOrEqual(52);
    const first = await lobby.page.getByTestId('big-clock').innerText();
    await expect.poll(() => lobby.page.getByTestId('big-clock').innerText(), { timeout: 8_000 }).not.toBe(first);
    // the event clock is still on the phones that need it, and the countdown is not it
    await expect(lobby.page.getByTestId('big-team')).toContainText('· 05:00');

    // RESET is an authoritative command: only the clock owner may send it, and it
    // restarts the official 5:00 (the round then waits for a supervisor decision).
    await expect(lobby.page.getByTestId('big-reset')).toBeDisabled();
    await gate.page.getByTestId('open-details').click();
    await gate.page.getByTestId('sheet-big-screen').click();
    await gate.page.getByTestId('big-reset').click();
    await gate.page.getByTestId('big-reset-confirm').click();
    await expect(gate.page.getByTestId('big-clock')).toHaveText(/^0[45]:\d\d$/);
    await expect(gate.page.getByTestId('big-reset-count')).toContainText('RESET 1');
    // the wall display mirrors the same authoritative clock, not a local copy
    await expect(lobby.page.getByTestId('big-clock')).toHaveText(/^0[45]:\d\d$/);
    await gate.page.getByTestId('big-close').click();

    // Digits-only mode: the number alone, and a tap brings the controls back.
    await lobby.page.getByTestId('big-focus').click();
    await expect(lobby.page.getByTestId('big-controls')).toBeHidden();
    await expect(lobby.page.getByTestId('big-team')).toBeHidden();
    await lobby.page.getByTestId('big-screen').click();
    await expect(lobby.page.getByTestId('big-controls')).toBeVisible();

    // Out of time: the screen flashes and the alarm is armed — but nothing is cleared.
    await sup.context.request.post('/api/dev/clock', {
      data: { advance_ms: 5 * 60 * 1000 + 20_000 },
      headers,
    });
    await expect(big).toHaveAttribute('data-expired', 'true');
    await expect(big).toHaveClass(/alarm-flash/);
    await expect(lobby.page.getByTestId('big-clock')).toHaveText('00:00');
    await expect(lobby.page.getByTestId('big-expired')).toContainText('HẾT GIỜ');
    // only GATE ends the countdown, and its own phone kept its button
    await expect(primary(gate.page)).toHaveText('KHÁCH ĐÃ RA — CHỐT GIỜ');

    await primary(gate.page).click();
    await expect(big).toBeHidden();
    await expect(lobby.page.getByTestId('dashboard')).toBeVisible();

    for (const { context } of [sup, lobby, gate]) await context.close();
  });

  test('19. no login form: a phone without a link only sees the invitation gate', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByTestId('invite-gate')).toBeVisible();

    // Nothing that looks like a login screen is offered any more.
    await expect(page.locator('input')).toHaveCount(0);
    await expect(page.getByTestId('passcode')).toHaveCount(0);
    await expect(page.getByTestId('role-LOBBY')).toHaveCount(0);

    // The self-hosted build still exposes its five stations to the suite.
    await expect(page.getByTestId('dev-station-LOBBY')).toBeVisible();
    await page.getByTestId('dev-station-SUPERVISOR').click();
    await expect(page.getByTestId('dashboard')).toBeVisible();
    await expect(page.getByTestId('role-tag')).toHaveText('SUP');
  });

  test('20. a redeemed station survives reopening without the link', async ({ browser }) => {
    const context = await browser.newContext();
    const page = await signIn(context, 'lobby');

    // Back to the bare origin: only the stored session can restore the station.
    await page.goto('/');
    await expect(page.getByTestId('dashboard')).toBeVisible();
    await expect(page.getByTestId('role-tag')).toHaveText('LOBBY');

    await page.reload();
    await expect(page.getByTestId('dashboard')).toBeVisible();
    await expect(page.getByTestId('role-tag')).toHaveText('LOBBY');

    await context.close();
  });
});
