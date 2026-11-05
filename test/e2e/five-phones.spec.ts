import { expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test';

type Phone = 'lobby' | 'corridor' | 'gate' | 'room305' | 'supervisor' | 'observer';

/** What each phone wears in its header pill. */
const ROLE_TAG: Record<Phone, string> = {
  lobby: '01',
  corridor: '02',
  gate: 'NPC 1',
  room305: 'NPC 2',
  supervisor: 'TRỊ',
  observer: 'XEM',
};

/**
 * The self-hosted engine has no Supabase to redeem an invitation against, so a
 * station link (`?station=lobby`) is its stand-in for the real board selection.
 */
async function signIn(context: BrowserContext, phone: Phone): Promise<Page> {
  const page = await context.newPage();
  await page.goto(`/?station=${phone}`);
  if (phone === 'observer') {
    await expect(page.getByTestId('observer')).toBeVisible();
    return page;
  }
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
const dashboard = (page: Page) => page.getByTestId('dashboard');

/** MM:SS as the hero clock renders it. */
const formatCs = (ms: number) => {
  const total = Math.max(0, Math.floor(ms / 10) * 10);
  return `${String(Math.floor(total / 60_000)).padStart(2, '0')}:${String(Math.floor((total % 60_000) / 1000)).padStart(2, '0')}`;
};

/** MM:SS.hh as the official-result card and the shared fraction render it. */
const formatClockCsLocal = (ms: number) => {
  const total = Math.max(0, Math.floor(ms / 10) * 10);
  return `${formatCs(total)}.${String(Math.floor((total % 1000) / 10)).padStart(2, '0')}`;
};

/** Resets every phone to a brand-new session through the dev-only endpoint. */
async function freshSession(sup: { page: Page; context: BrowserContext }, pages: Page[]) {
  const token = await sup.page.evaluate(
    () => JSON.parse(localStorage.getItem('sc305.session.v1') ?? '{}').token as string,
  );
  const res = await sup.context.request.post('/api/dev/reset', { headers: { authorization: `Bearer ${token}` } });
  expect(res.ok()).toBe(true);
  for (const page of pages) await page.reload();
  for (const page of pages) {
    await expect(page.getByTestId('dashboard')).toBeVisible();
  }
}

/** Reception → floor 2 → START: the three presses that put a clock on the floor. */
async function toCountdown(lobby: Page, corridor: Page, gate: Page) {
  await expect(primary(lobby)).toHaveText('NHẬN ĐỘI & CHO LÊN TẦNG 2');
  await primary(lobby).click();
  await expect(primary(corridor)).toHaveText('XÁC NHẬN ĐỘI ĐÃ ĐẾN TẦNG 2');
  await primary(corridor).click();
  await expect(primary(gate)).toHaveText('BẮT ĐẦU TRÒ CHƠI — 05:00');
  await primary(gate).click();
  await expect(gate.getByTestId('countdown-screen')).toBeVisible();
}

/**
 * V3.4 §5/§7: the irreversible presses — finalising a result and confirming a
 * physical exit — arm on the first tap and land on the second. E2E drives the
 * real two-press gesture, never a bypass of it.
 */
async function twoPress(button: Page | ReturnType<Page['getByTestId']>) {
  await (button as ReturnType<Page['getByTestId']>).click();
  await (button as ReturnType<Page['getByTestId']>).click();
}

async function snapshotOf(sup: { page: Page; context: BrowserContext }) {
  const token = await sup.page.evaluate(
    () => JSON.parse(localStorage.getItem('sc305.session.v1') ?? '{}').token as string,
  );
  return (await (await sup.context.request.get('/api/snapshot', { headers: { authorization: `Bearer ${token}` } })).json()) as {
    revision: number;
    phase: string;
    active_round: Record<string, string | number | null> | null;
    attempts: { id: string; seq: number; claimed_at: number; elapsed_ms: number; status: string; in_time: boolean }[];
    log: { action: string; metadata?: Record<string, unknown> }[];
  };
}

test.describe.serial('SCREAM CONTROL V3 — one flow, every phone', () => {
  test('runs a complete round: reception, floor 2, countdown, claim, exit, closure', async ({ browser }) => {
    const lobby = await phone(browser, 'lobby');
    const corridor = await phone(browser, 'corridor');
    const gate = await phone(browser, 'gate');
    const room = await phone(browser, 'room305');
    const sup = await phone(browser, 'supervisor');
    const pages = [lobby.page, corridor.page, gate.page, room.page, sup.page];
    await freshSession(sup, pages);

    // §5 Before the first team: one control on one phone, a grey lock everywhere else.
    await expect(primary(lobby.page)).toHaveText('NHẬN ĐỘI & CHO LÊN TẦNG 2');
    await expect(gate.page.getByTestId('waiting-state')).toContainText('ĐANG CHỜ TIẾP NHẬN ĐỘI CHƠI');
    await expect(sup.page.getByTestId('waiting-state')).toContainText('ĐANG CHỜ TIẾP NHẬN ĐỘI CHƠI');
    await expect(corridor.page.getByTestId('waiting-state')).toBeDisabled();

    // The optional label is drafted before the press and travels with it.
    await lobby.page.getByTestId('team-edit').click();
    await lobby.page.getByTestId('team-name').fill('Ma Tro');
    await primary(lobby.page).click();
    await expect(lobby.page.getByTestId('team-status')).toContainText('Ma Tro');
    // OPERATOR_01 is done for this team: sending up and confirming arrival differ.
    await expect(lobby.page.getByTestId('waiting-state')).toContainText('ĐÃ CHO ĐỘI LÊN TẦNG 2');

    // §6 Only OPERATOR_02 confirms arrival, and no clock has started anywhere.
    await expect(corridor.page.getByTestId('primary-action')).toHaveText('XÁC NHẬN ĐỘI ĐÃ ĐẾN TẦNG 2');
    // NPC1 holds the documented exception for this phase, and it asks why first.
    await expect(gate.page.getByTestId('primary-action')).toHaveText('ĐỘI ĐÃ ĐẾN TẦNG 3 — BỎ QUA XÁC NHẬN TẦNG 2');
    await corridor.page.getByTestId('primary-action').click();
    const confirmed = await snapshotOf(sup);
    expect(confirmed.active_round?.floor2_confirmed_at).not.toBeNull();
    expect(confirmed.active_round?.floor2_bypassed_at).toBeNull();
    expect(confirmed.active_round?.floor2_confirmed_by_role).toBe('CORRIDOR');
    // Confirmation of arrival is not the start: 02 has no clock authority at all.
    expect(confirmed.active_round?.game_started_at).toBeNull();
    // V3.4 Role 02: the landed press is acknowledged; the caption names the hand.
    await expect(corridor.page.getByTestId('waiting-state')).toContainText('ĐÃ XÁC NHẬN ĐỘI ĐẾN TẦNG 2');

    // §8 Pre-start: the same loud alert on every phone, one START permission.
    await expect(room.page.getByTestId('prestart-alert')).toBeVisible();
    await expect(room.page.getByTestId('waiting-state')).toContainText('ĐỘI CHƠI SẮP BẮT ĐẦU');
    await expect(primary(gate.page)).toHaveText('BẮT ĐẦU TRÒ CHƠI — 05:00');
    await primary(gate.page).click();

    // §9 The countdown locks every screen: no navigation, no editing, no old buttons.
    for (const page of pages) await expect(dashboard(page)).toHaveAttribute('data-locked', '1');
    await expect(gate.page.getByTestId('countdown-screen')).toBeVisible();
    await expect(gate.page.getByTestId('hero-clock')).toHaveText(/^0[45]:\d\d/);
    await expect(gate.page.getByTestId('open-details')).toHaveCount(0);
    await expect(gate.page.getByTestId('journey-strip')).toHaveCount(0);
    await expect(gate.page.getByTestId('clock-controls')).toHaveCount(0);
    // V3.1 §IV: the operator surface is Vietnamese end-to-end; `resolveCountdown.statusLine`
    // now reads `● ĐANG CHẠY MM:SS`, never the raw `RUNNING` enum.
    await expect(gate.page.getByTestId('countdown-status')).toContainText('ĐANG CHẠY');
    // The hundredths exist as their own, much smaller field beside the main clock.
    const fraction = gate.page.locator('.countdown-fraction');
    await expect(fraction).toBeVisible();
    const mainPx = await gate.page.getByTestId('hero-clock').evaluate((el) => parseFloat(getComputedStyle(el).fontSize));
    const fractionPx = await fraction.evaluate((el) => parseFloat(getComputedStyle(el).fontSize));
    expect(fractionPx).toBeLessThan(mainPx / 2);

    // §10 NPC2 records the announcement; the countdown deliberately keeps running.
    await expect(room.page.getByTestId('record-claim')).toHaveText('GHI NHẬN BÁO HOÀN THÀNH');
    await room.page.getByTestId('record-claim').click();
    // V3.4 §5: the pending attempt wears its own verification card — attempt
    // number, recorded timestamp, and the two decisions with their meaning.
    await expect(room.page.getByTestId('verify-head-1')).toContainText('LẦN 1');
    await expect(room.page.getByTestId('verify-state-1')).toContainText('ĐANG CHỜ XÁC MINH');
    await expect(room.page.getByTestId('attempt-hint')).toContainText('đồng hồ vẫn chạy');
    const claimed = await snapshotOf(sup);
    const claim = claimed.attempts[0];
    expect(claim.status).toBe('PENDING');
    expect(claim.in_time).toBe(true);
    await expect(room.page.getByTestId('hero-clock')).toHaveAttribute('data-mode', 'GAME');

    // Reject once: the claim keeps its own timestamp and the clock keeps running.
    await room.page.getByTestId('attempt-invalid-1').click();
    await expect.poll(async () => (await snapshotOf(sup)).attempts[0].status).toBe('INVALID');
    await room.page.getByTestId('record-claim').click();
    await expect.poll(async () => (await snapshotOf(sup)).attempts.length).toBe(2);

    // Verify the second claim: the score is that claim's instant, not this press.
    const second = (await snapshotOf(sup)).attempts[1];
    // V3.4 §5: the finalisation is armed by the first tap and lands on the second.
    await room.page.getByTestId('attempt-valid-2').click();
    await expect(room.page.getByTestId('attempt-valid-2')).toHaveText('XÁC NHẬN CHỐT KẾT QUẢ');
    await room.page.getByTestId('attempt-valid-2').click();
    await expect.poll(async () => (await snapshotOf(sup)).active_round?.result).toBe('WON');
    const won = await snapshotOf(sup);
    // The score is the second claim's own instant…
    expect(won.active_round?.official_duration_ms).toBe(second.elapsed_ms);
    // …never the instant NPC2 finished checking, which is audited apart.
    const audit = won.log.filter((l) => l.action === 'VERIFY_ATTEMPT').at(-1)?.metadata;
    expect(audit?.claimed_at).toBe(second.claimed_at);
    expect((audit?.verification_delay_ms as number) ?? 0).toBeGreaterThanOrEqual(0);
    // V3.4 §6: the milestone presentation replaces the CTA entirely — NPC2's
    // screen is read-only for completion reporting, exactly like the RPC.
    await expect(room.page.getByTestId('official-result')).toBeVisible();
    await expect(room.page.getByTestId('official-result-title')).toContainText('ĐÃ CHỐT KẾT QUẢ');
    // The card carries the claim's own instant to hundredths — the same value
    // the board ranks, never a rounded UI artefact.
    await expect(room.page.getByTestId('official-result-time')).toHaveText(formatClockCsLocal(second.elapsed_ms));
    await expect(room.page.getByTestId('official-result-wait')).toContainText('Đang chờ NPC 1 xác nhận đội rời tầng 3.');
    await expect(room.page.getByTestId('record-claim')).toHaveCount(0);
    // The rejected first attempt keeps its row and its own timestamp (§4).
    await expect(room.page.getByTestId('attempt-1')).toHaveAttribute('data-status', 'INVALID');
    // NPC1 still sees the official result line on its own screen.
    await expect(gate.page.getByTestId('countdown-official')).toContainText('KẾT QUẢ CHÍNH THỨC');
    // §10 step B: the countdown display stops the moment the round is decided, and the
    // number it keeps is the official one rather than a timer running to nothing.
    await expect(room.page.getByTestId('countdown-label')).toHaveText('THỜI GIAN HOÀN THÀNH');
    const hero = await room.page.getByTestId('hero-clock').textContent();
    const official = formatCs(second.elapsed_ms);
    expect(hero).toBe(official);
    await room.page.waitForTimeout(1_300);
    await expect(room.page.getByTestId('hero-clock')).toHaveText(official);

    // §12 The exit is a second, separate event that cannot move the score.
    await expect(gate.page.getByTestId('primary-action')).toHaveText('XÁC NHẬN ĐỘI ĐÃ RỜI TẦNG 3');
    // V3.4 §7: the hand-off states what is already confirmed before the press.
    await expect(gate.page.getByTestId('npc1-handoff')).toBeVisible();
    await expect(gate.page.getByTestId('npc1-handoff-state')).toContainText('NPC 2 ĐÃ CHỐT KẾT QUẢ');
    await gate.page.getByTestId('primary-action').click();
    await expect(gate.page.getByTestId('primary-action')).toHaveText('XÁC NHẬN LẠI: ĐỘI ĐÃ RỜI TẦNG 3');
    await gate.page.getByTestId('primary-action').click();
    await expect.poll(async () => (await snapshotOf(sup)).active_round?.status).toBe('EXIT_CONFIRMED');
    const exited = await snapshotOf(sup);
    expect(exited.active_round?.official_duration_ms).toBe(second.elapsed_ms);
    expect(exited.active_round?.exit_by_role).toBe('GATE');

    // §13 The physical checks are confirmed by the staff who own them, then closed.
    // V3.4 §4: NPC 1's confirmation names the one area its own rows cover — the
    // hallway — and must never read as a claim over the whole floor. NPC 2 keeps
    // its approved wording and only its hint lists the areas it owes.
    await expect(gate.page.getByTestId('primary-action')).toHaveText('XÁC NHẬN ĐÃ RESET HÀNH LANG');
    await expect(gate.page.getByTestId('primary-action')).not.toHaveText('ĐÃ RESET XONG');
    await expect(room.page.getByTestId('primary-action')).toHaveText('ĐÃ RESET XONG');
    await gate.page.getByTestId('primary-action').click();
    await room.page.getByTestId('primary-action').click();
    await expect(gate.page.getByTestId('primary-action')).toHaveText('XÁC NHẬN SẴN SÀNG');
    await gate.page.getByTestId('primary-action').click();
    await expect.poll(async () => (await snapshotOf(sup)).active_round).toBeNull();

    // §5 The lobby may receive the next team as soon as the area is cleared.
    await expect(primary(lobby.page)).toHaveText('NHẬN ĐỘI & CHO LÊN TẦNG 2');
    await expect(lobby.page.getByTestId('journey-strip')).toHaveAttribute('data-position', '0');

    // The ranking carries the claim-based time, and the wall clock shows ms detail.
    await lobby.page.getByTestId('open-details').click();
    // V3.2 IA: the report tab shows rounds, ranking and audit flat — no accordions.
    await lobby.page.getByTestId('sheet-tab-report').click();
    await expect(lobby.page.getByTestId('leaderboard-table')).toContainText('#001');
    await expect(lobby.page.getByTestId('round-detail-1')).toContainText('Điểm chính thức');
    await expect(lobby.page.getByTestId('claims-1')).toContainText('Lần 1');
    // V3.1 §IV: the attempt decision reads `CHƯA ĐÚNG` (from ATTEMPT_LABEL.INVALID),
    // never the raw `INVALID` key. The uppercase is the deliberate visual weight of
    // the label layer, matching the operator's "seen as a decision" style.
    await expect(lobby.page.getByTestId('claims-1')).toContainText('CHƯA ĐÚNG');
    // The audit line is written for a human on the floor, not as an action id.
    await expect(lobby.page.getByTestId('history')).toContainText('ghi nhận báo hoàn thành');
    await expect(lobby.page.getByTestId('history')).toContainText('đã rời tầng 3');
    // V3.1 §IV: the actor column wears `ROLE_SHORT` ("NPC 2"), never the raw key.
    await expect(lobby.page.getByTestId('history')).toContainText('NPC 2');
    await expect(lobby.page.getByTestId('history')).not.toContainText('ROOM305');
    await lobby.page.getByTestId('close-details').click();

    for (const { context } of [lobby, corridor, gate, room, sup]) await context.close();
  });

  test('§7 the floor-2 bypass keeps its own audit and refuses a stale confirmation', async ({ browser }) => {
    const lobby = await phone(browser, 'lobby');
    const corridor = await phone(browser, 'corridor');
    const gate = await phone(browser, 'gate');
    const room = await phone(browser, 'room305');
    const sup = await phone(browser, 'supervisor');
    await freshSession(sup, [lobby.page, corridor.page, gate.page, room.page, sup.page]);

    await primary(lobby.page).click();
    // An exception without a reason cannot be sent, and without a second press
    // either: an accidental tap must never skip a floor.
    await expect(primary(gate.page)).toHaveText('ĐỘI ĐÃ ĐẾN TẦNG 3 — BỎ QUA XÁC NHẬN TẦNG 2');
    await gate.page.getByTestId('primary-action').click();
    await expect(gate.page.getByTestId('reason-input')).toBeVisible();
    await expect(gate.page.getByTestId('primary-action')).toBeDisabled();
    await gate.page.getByTestId('reason-input').fill('Đội đã lên thẳng tầng 3');
    await expect(gate.page.getByTestId('primary-action')).toBeEnabled();
    await expect(gate.page.getByTestId('primary-action')).toHaveText('XÁC NHẬN BỎ QUA TẦNG 2');
    await gate.page.getByTestId('primary-action').click();

    await expect.poll(async () => (await snapshotOf(sup)).active_round?.status).toBe('READY_AT_FLOOR3');
    const bypassed = await snapshotOf(sup);
    // The integrity rule: a bypass is not a fabricated floor-2 confirmation.
    expect(bypassed.active_round?.floor2_confirmed_at).toBeNull();
    expect(bypassed.active_round?.floor2_bypassed_at).not.toBeNull();
    expect(bypassed.active_round?.floor2_bypassed_by_role).toBe('GATE');
    expect(bypassed.active_round?.floor2_bypass_reason).toBe('Đội đã lên thẳng tầng 3');
    expect(bypassed.active_round?.needs_review).toBe(true);

    // The late OPERATOR_02 press is refused safely and the workflow does not revert.
    // V3.4 Role 02: a bypassed floor is its own caption — never a confirmation.
    await expect(corridor.page.getByTestId('waiting-state')).toContainText('TẦNG 2 ĐÃ ĐƯỢC BỎ QUA');
    expect((await snapshotOf(sup)).active_round?.floor2_confirmed_at).toBeNull();
    // The game continues normally from the bypass.
    await primary(gate.page).click();
    await expect(gate.page.getByTestId('countdown-screen')).toBeVisible();
    for (const { context } of [lobby, corridor, gate, room, sup]) await context.close();
  });

  test('a claim before the deadline stays a win when it is checked afterwards', async ({ browser }) => {
    const lobby = await phone(browser, 'lobby');
    const corridor = await phone(browser, 'corridor');
    const gate = await phone(browser, 'gate');
    const room = await phone(browser, 'room305');
    const sup = await phone(browser, 'supervisor');
    await freshSession(sup, [lobby.page, corridor.page, gate.page, room.page, sup.page]);
    await toCountdown(lobby.page, corridor.page, gate.page);

    await room.page.getByTestId('record-claim').click();
    const claim = (await snapshotOf(sup)).attempts[0];
    // Let the 5:00 lapse while NPC2 is still at the arrangement.
    const token = await sup.page.evaluate(
      () => JSON.parse(localStorage.getItem('sc305.session.v1') ?? '{}').token as string,
    );
    await sup.context.request.post('/api/dev/clock', {
      data: { advance_ms: 300_000 + 8_000 },
      headers: { authorization: `Bearer ${token}` },
    });
    // The provisional state, on the phone that owns the decision.
    await expect(room.page.getByTestId('countdown-status')).toContainText('ĐANG CHỜ XÁC MINH');
    await twoPress(room.page.getByTestId(`attempt-valid-${claim.seq}`));
    await expect.poll(async () => (await snapshotOf(sup)).active_round?.result).toBe('WON');
    const won = await snapshotOf(sup);
    // Success at the claim instant — the eight seconds of checking cost nothing.
    expect(won.active_round?.official_duration_ms).toBe(claim.elapsed_ms);
    // The claim never became the exit instant either: the round is still open.
    expect(won.active_round?.exit_confirmed_at).toBeNull();
    // NPC1 may still let the team out afterwards, without touching the score.
    await expect(gate.page.getByTestId('primary-action')).toHaveText('XÁC NHẬN ĐỘI ĐÃ RỜI TẦNG 3');
    for (const { context } of [lobby, corridor, gate, room, sup]) await context.close();
  });

  test('the clock running out is TIME UP, and nobody may pause or restart it', async ({ browser }) => {
    const lobby = await phone(browser, 'lobby');
    const corridor = await phone(browser, 'corridor');
    const gate = await phone(browser, 'gate');
    const room = await phone(browser, 'room305');
    const sup = await phone(browser, 'supervisor');
    await freshSession(sup, [lobby.page, corridor.page, gate.page, room.page, sup.page]);
    await toCountdown(lobby.page, corridor.page, gate.page);

    const token = await sup.page.evaluate(
      () => JSON.parse(localStorage.getItem('sc305.session.v1') ?? '{}').token as string,
    );
    await sup.context.request.post('/api/dev/clock', {
      data: { advance_ms: 300_000 + 15_000 },
      headers: { authorization: `Bearer ${token}` },
    });
    // The display stops at zero instead of counting into negative digits.
    await expect(gate.page.getByTestId('hero-clock')).toHaveText('00:00');
    await expect(gate.page.getByTestId('countdown-label')).toHaveText('HẾT GIỜ');
    const expired = await snapshotOf(sup);
    expect(expired.active_round?.game_stopped_at).toBeNull();
    expect(expired.active_round?.official_duration_ms).toBeNull();
    expect(expired.phase).toBe('WAITING_FOR_EXIT');

    // §9 Nobody holds a pause, resume or reset control any more.
    await expect(gate.page.getByTestId('clock-pause')).toHaveCount(0);
    await expect(gate.page.getByTestId('clock-reset')).toHaveCount(0);
    await expect(gate.page.getByTestId('big-reset')).toHaveCount(0);
    // A late announcement is recorded as information and cannot win.
    await room.page.getByTestId('record-claim').click();
    await expect.poll(async () => (await snapshotOf(sup)).attempts.length).toBe(1);
    const late = (await snapshotOf(sup)).attempts[0];
    expect(late.in_time).toBe(false);
    expect(late.status).toBe('LATE');
    await expect(room.page.getByTestId(`attempt-valid-${late.seq}`)).toBeDisabled();
    // The guarded safety path stays available to NPC1, and it is secondary.
    await expect(gate.page.getByTestId('emergency-open')).toBeVisible();
    await twoPress(gate.page.getByTestId('primary-action'));
    await expect.poll(async () => (await snapshotOf(sup)).active_round?.status).toBe('EXIT_CONFIRMED');
    await expect.poll(async () => (await snapshotOf(sup)).active_round?.result).toBe('TIME_UP');
    for (const { context } of [lobby, corridor, gate, room, sup]) await context.close();
  });

  test('an early exit needs a reason and never fabricates a successful time', async ({ browser }) => {
    const lobby = await phone(browser, 'lobby');
    const corridor = await phone(browser, 'corridor');
    const gate = await phone(browser, 'gate');
    const room = await phone(browser, 'room305');
    const sup = await phone(browser, 'supervisor');
    await freshSession(sup, [lobby.page, corridor.page, gate.page, room.page, sup.page]);
    await toCountdown(lobby.page, corridor.page, gate.page);

    // Only NPC1 holds the path out, and it is not the primary control.
    await expect(room.page.getByTestId('emergency-open')).toHaveCount(0);
    await expect(gate.page.getByTestId('primary-action')).toHaveCount(0);
    await gate.page.getByTestId('emergency-open').click();
    await expect(gate.page.getByTestId('emergency-confirm')).toBeDisabled();
    await gate.page.getByTestId('emergency-reason').fill('Khách cần y tế');
    await gate.page.getByTestId('emergency-confirm').click();
    await expect.poll(async () => (await snapshotOf(sup)).active_round?.result).toBe('ABORTED');
    const aborted = await snapshotOf(sup);
    expect(aborted.active_round?.official_duration_ms).toBeNull();
    expect(aborted.active_round?.exit_reason).toBe('Khách cần y tế');
    expect(aborted.active_round?.exit_confirmed_at).not.toBeNull();
    // The area still has to be put back ready before the next team. NPC 1 presses
    // only for its own hallway row (V3.4 §4).
    await expect(gate.page.getByTestId('primary-action')).toHaveText('XÁC NHẬN ĐÃ RESET HÀNH LANG');
    for (const { context } of [lobby, corridor, gate, room, sup]) await context.close();
  });

  test('the observer watches, and can change nothing', async ({ browser }) => {
    const lobby = await phone(browser, 'lobby');
    const corridor = await phone(browser, 'corridor');
    const gate = await phone(browser, 'gate');
    const room = await phone(browser, 'room305');
    const sup = await phone(browser, 'supervisor');
    const viewer = await phone(browser, 'observer');
    await freshSession(sup, [lobby.page, corridor.page, gate.page, room.page, sup.page]);
    await viewer.page.reload();
    await expect(viewer.page.getByTestId('observer')).toBeVisible();

    await toCountdown(lobby.page, corridor.page, gate.page);
    await expect(viewer.page.getByTestId('observer-clock')).toHaveText(/^0[45]:\d\d/);
    // V3.1 §IV: viewer status reads the same Vietnamese string as the operator screen.
    await expect(viewer.page.getByTestId('observer-status')).toContainText('ĐANG CHẠY');
    await expect(viewer.page.getByTestId('observer-team')).toBeVisible();
    // No control at all: not a primary button, not a lock, not a settings entry.
    await expect(viewer.page.getByTestId('primary-action')).toHaveCount(0);
    await expect(viewer.page.getByTestId('record-claim')).toHaveCount(0);
    await expect(viewer.page.getByTestId('emergency-open')).toHaveCount(0);
    await expect(viewer.page.getByTestId('open-details')).toHaveCount(0);
    await expect(viewer.page.getByTestId('observer-connection')).toHaveAttribute('data-status', 'CONNECTED');
    // The seat survives a reload, because the viewer identity is kept on the device.
    await viewer.page.reload();
    await expect(viewer.page.getByTestId('observer')).toBeVisible();
    await expect(viewer.page.getByTestId('observer-clock')).toHaveText(/^0[45]:\d\d/);
    // The claim and the official time reach the viewer; the claim list does not.
    await room.page.getByTestId('record-claim').click();
    const claim = (await snapshotOf(sup)).attempts[0];
    await twoPress(room.page.getByTestId(`attempt-valid-${claim.seq}`));
    await expect.poll(async () => (await snapshotOf(sup)).active_round?.result).toBe('WON');
    await expect.poll(() => viewer.page.getByTestId('observer-status').textContent()).toContain('THÀNH CÔNG');
    await viewer.page.getByTestId('observer-leave').click();
    await expect(viewer.page.getByTestId('scream-home')).toBeVisible();

    for (const { context } of [lobby, corridor, gate, room, sup, viewer]) await context.close();
  });

  test('every screen fits 360px, including the locked countdown', async ({ browser }) => {
    const lobby = await phone(browser, 'lobby');
    const corridor = await phone(browser, 'corridor');
    const gate = await phone(browser, 'gate');
    const room = await phone(browser, 'room305');
    const sup = await phone(browser, 'supervisor');
    await freshSession(sup, [lobby.page, corridor.page, gate.page, room.page, sup.page]);

    for (const which of ['lobby', 'corridor', 'gate', 'room305', 'supervisor', 'observer'] as Phone[]) {
      const context = await browser.newContext({ viewport: { width: 360, height: 640 } });
      const page = await signIn(context, which);
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      );
      expect(overflow, `${which} overflows by ${overflow}px`).toBeLessThanOrEqual(0);
      if (which !== 'observer') {
        await page.getByTestId('open-details').click();
        const sheetOverflow = await page.evaluate(
          () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
        );
        expect(sheetOverflow, `${which} sheet overflows`).toBeLessThanOrEqual(0);
        await page.getByTestId('close-details').click();
      } else {
        // A viewer has no sheet to open, only its own read-only board.
        await expect(page.getByTestId('observer-phase')).toBeVisible();
      }
      await context.close();
    }

    // The locked screen is the one that must never scroll sideways: the clock, the
    // NPC 2 panel and the emergency control all have to fit a 360 px phone.
    await toCountdown(lobby.page, corridor.page, gate.page);
    for (const [name, page] of [
      ['room305', room.page],
      ['gate', gate.page],
      ['lobby', lobby.page],
    ] as const) {
      await expect(page.getByTestId('countdown-screen')).toBeVisible();
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      );
      expect(overflow, `${name} countdown overflows by ${overflow}px`).toBeLessThanOrEqual(0);
    }
    // NPC 2 records an announcement so its two decision buttons are on screen.
    await room.page.getByTestId('record-claim').click();
    await expect(room.page.getByTestId('verify-card-1')).toBeVisible();
    const claimOverflow = await room.page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(claimOverflow).toBeLessThanOrEqual(0);
    // NPC 1 opens the guarded path so its reason row is measured too.
    await gate.page.getByTestId('emergency-open').click();
    await expect(gate.page.getByTestId('emergency-reason')).toBeVisible();
    const emergencyOverflow = await gate.page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(emergencyOverflow).toBeLessThanOrEqual(0);
  });

  test('the same flow on a desktop screen keeps the countdown the dominant number', async ({ browser }) => {
    const desktop = async (which: Phone) => {
      const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
      return { context, page: await signIn(context, which) };
    };
    const lobby = await desktop('lobby');
    const corridor = await desktop('corridor');
    const gate = await desktop('gate');
    const room = await desktop('room305');
    const viewer = await desktop('observer');
    const sup = await phone(browser, 'supervisor');
    await freshSession(sup, [lobby.page, corridor.page, gate.page, room.page, sup.page]);
    await viewer.page.reload();
    await expect(viewer.page.getByTestId('observer')).toBeVisible();

    // Nothing may run sideways at 1280 either — the same rule as the smallest phone.
    const fits = async (name: string, page: Page) => {
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      );
      expect(overflow, `${name} overflows by ${overflow}px`).toBeLessThanOrEqual(0);
    };
    for (const [name, p] of [
      ['lobby', lobby], ['corridor', corridor], ['gate', gate], ['room305', room], ['observer', viewer],
    ] as const) await fits(name, p.page);

    await toCountdown(lobby.page, corridor.page, gate.page);
    for (const [name, p] of [['gate', gate], ['room305', room], ['observer', viewer]] as const) {
      await fits(`${name} countdown`, p.page);
    }
    // Minutes and seconds carry the wide screen too, and the hundredths stay an
    // order of magnitude smaller so they never compete with the clock.
    const mainPx = await gate.page.getByTestId('hero-clock').evaluate((el) => parseFloat(getComputedStyle(el).fontSize));
    const fractionPx = await gate.page.locator('.countdown-fraction').evaluate((el) => parseFloat(getComputedStyle(el).fontSize));
    expect(mainPx).toBeGreaterThanOrEqual(54);
    expect(fractionPx).toBeLessThan(mainPx / 2);
    await expect(gate.page.getByTestId('hero-clock')).toHaveText(/^0[45]:\d\d/);

    // The wall display is the desktop surface: one enormous number, no controls.
    await gate.page.getByTestId('countdown-big').click();
    await expect(gate.page.getByTestId('big-screen')).toBeVisible();
    const wallPx = await gate.page.getByTestId('big-clock').evaluate((el) => parseFloat(getComputedStyle(el).fontSize));
    expect(wallPx).toBeGreaterThan(mainPx * 2);
    await expect(gate.page.getByTestId('clock-pause')).toHaveCount(0);
    await gate.page.keyboard.press('Escape');

    for (const { context } of [lobby, corridor, gate, room, viewer, sup]) await context.close();
  });

  test('the wall display mirrors the same clock and holds no clock control', async ({ browser }) => {
    const lobby = await phone(browser, 'lobby');
    const corridor = await phone(browser, 'corridor');
    const gate = await phone(browser, 'gate');
    const room = await phone(browser, 'room305');
    const sup = await phone(browser, 'supervisor');
    await freshSession(sup, [lobby.page, corridor.page, gate.page, room.page, sup.page]);

    // A station with nothing left to press becomes the wall by itself.
    await toCountdown(lobby.page, corridor.page, gate.page);
    const big = lobby.page.getByTestId('big-screen');
    await expect(big).toBeVisible();
    await expect(lobby.page.getByTestId('big-clock')).toHaveText(/^0[45]:\d\d/);
    await expect(lobby.page.getByTestId('big-team')).toContainText('· 05:00');
    const digitPx = await lobby.page.getByTestId('big-clock').evaluate((el) => parseFloat(getComputedStyle(el).fontSize));
    expect(digitPx).toBeGreaterThanOrEqual(52);
    // The fraction is on screen but visibly subordinate to MM:SS.
    const fractionPx = await lobby.page.locator('.wall-fraction').evaluate((el) => parseFloat(getComputedStyle(el).fontSize));
    expect(fractionPx).toBeLessThan(digitPx / 3);
    const first = await lobby.page.getByTestId('big-clock').innerText();
    await expect.poll(() => lobby.page.getByTestId('big-clock').innerText(), { timeout: 8_000 }).not.toBe(first);
    // No pause, no reset: the wall cannot touch the authoritative clock.
    await expect(lobby.page.getByTestId('big-pause')).toHaveCount(0);
    await expect(lobby.page.getByTestId('big-reset')).toHaveCount(0);

    // Out of time: calm red state, 00:00, and no automatic clear.
    const token = await sup.page.evaluate(
      () => JSON.parse(localStorage.getItem('sc305.session.v1') ?? '{}').token as string,
    );
    await sup.context.request.post('/api/dev/clock', {
      data: { advance_ms: 300_000 + 10_000 },
      headers: { authorization: `Bearer ${token}` },
    });
    await expect(big).toHaveClass(/alarm-glow/);
    await expect(lobby.page.getByTestId('big-clock')).toHaveText('00:00');
    await expect(lobby.page.getByTestId('big-expired')).toContainText('HẾT GIỜ');
    await expect.poll(async () => (await snapshotOf(sup)).active_round?.exit_confirmed_at).toBeNull();
    // Only NPC1 ends it, from its own phone — with the two-press guard.
    await twoPress(gate.page.getByTestId('primary-action'));
    await expect(big).toBeHidden();

    for (const { context } of [lobby, corridor, gate, room, sup]) await context.close();
  });

  test('19. root Home offers four stations plus a separate viewer band, and no admin entry', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByTestId('scream-home')).toBeVisible();

    // Nothing that looks like a login screen is offered for a station or a seat.
    // V3.4: the overview counts the four duty seats and the ten viewer seats
    // separately — never the aggregate that also carries the hidden admin seats.
    await expect(page.getByTestId('station-count')).toHaveText(/\d\/4/);
    await expect(page.getByTestId('observer-count')).toHaveText(/\d\/10/);
    await expect(page.locator('.home-station')).toHaveCount(4);
    await expect(page.locator('.home-observer-card')).toHaveCount(1);
    for (const role of ['LOBBY', 'CORRIDOR', 'GATE', 'ROOM305']) {
      await expect(page.getByTestId(`station-${role}`)).toHaveAttribute('data-state', /available|unknown|full/);
    }
    await expect(page.getByTestId('station-OBSERVER')).toHaveAttribute('data-state', /available|unknown|full/);
    // V3.2: the retained admin is not a board tile and the public page never even
    // shows the admin line — there is no PIN sheet anywhere to reach.
    await expect(page.getByTestId('station-SUPERVISOR')).toHaveCount(0);
    await expect(page.getByTestId('home-admin-open')).toHaveCount(0);
    await expect(page.getByTestId('admin-panel')).toHaveCount(0);
    await expect(page.locator('input')).toHaveCount(0);
  });

  test('19b. /admin binds the retained admin with a single tap, no credential', async ({ page }) => {
    await page.goto('/admin');
    await expect(page.getByTestId('admin-panel')).toBeVisible();
    await page.getByTestId('home-admin-open').click();
    await expect(page.getByTestId('dashboard')).toBeVisible();
    await expect(page.getByTestId('role-tag')).toHaveText('TRỊ');
  });

  test('20. a redeemed station survives reopening without the link', async ({ browser }) => {
    const context = await browser.newContext();
    const page = await signIn(context, 'lobby');

    // Back to the bare origin: only the stored session can restore the station.
    await page.goto('/');
    await expect(page.getByTestId('dashboard')).toBeVisible();
    await expect(page.getByTestId('role-tag')).toHaveText('01');

    await page.reload();
    await expect(page.getByTestId('dashboard')).toBeVisible();
    await expect(page.getByTestId('role-tag')).toHaveText('01');

    await context.close();
  });
});
