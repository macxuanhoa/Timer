import { unlockAdmin } from './lib/admin';
import { expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { mkdirSync } from 'node:fs';

/**
 * V3.4 — NPC 1 · CỬA VÀO TẦNG 3, the three screens as one workflow.
 *
 * Screen A (pre-start), Screen B (the official countdown) and Screen C (the
 * wall display) are driven end-to-end on the real dev engine, and every
 * regression the redesign must not break is asserted here: START happens
 * once, the duration is snapshotted, the wall matches the phone second for
 * second, the hundredths read as a fraction, the palette is ember — never
 * green — and the guarded early exit keeps its business rules.
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

async function supToken(sup: Page): Promise<string> {
  return sup.evaluate(() => JSON.parse(localStorage.getItem('sc305.session.v1') ?? '{}').token as string);
}

async function snapshotOf(sup: { page: Page; context: BrowserContext }) {
  const res = await sup.context.request.get('/api/snapshot', {
    headers: { authorization: `Bearer ${await supToken(sup.page)}` },
  });
  return (await res.json()) as {
    phase: string;
    active_round: Record<string, unknown> | null;
    log: { action: string }[];
  };
}

const shot = async (page: Page, name: string) => {
  mkdirSync('shots', { recursive: true });
  await page.screenshot({ path: `shots/v34-${name}.png` });
};

/** MM:SS as the hero renders it, to seconds. */
const clockSeconds = (text: string | null): number => {
  const m = /^(\d\d):(\d\d)$/.exec((text ?? '').trim());
  return m ? Number(m[1]) * 60 + Number(m[2]) : Number.NaN;
};

const EMBER = 'rgb(244, 137, 58)'; // COUNTDOWN_TONE.ok
const BLOOD = 'rgb(226, 72, 61)'; // COUNTDOWN_TONE.danger
const OLD_GREEN = 'rgb(31, 185, 110)'; // the V3.2 wall colour that must never return

test.describe.serial('V3.4 NPC1 — three screens, one countdown contract', () => {
  test('pre-start, START once, live countdown, wall match, expiry, ember palette', async ({ browser }) => {
    test.setTimeout(240_000);
    const lobby = await phone(browser, 'lobby');
    const corridor = await phone(browser, 'corridor');
    const gate = await phone(browser, 'gate');
    const room = await phone(browser, 'room305');
    const sup = await phone(browser, 'supervisor');
    const pages = [lobby.page, corridor.page, gate.page, room.page, sup.page];

    const res = await sup.context.request.post('/api/dev/reset', { headers: { authorization: `Bearer ${await supToken(sup.page)}` } });
    expect(res.ok()).toBe(true);
    for (const p of pages) await p.reload();
    for (const p of pages) await expect(p.getByTestId('dashboard')).toBeVisible();

    // Reception and floor 2 — nothing NPC1-specific yet.
    await lobby.page.getByTestId('primary-action').click();
    await corridor.page.getByTestId('primary-action').click();

    /* ---------------------------------------------------------- Screen A */
    await expect(gate.page.getByTestId('prestart-alert')).toBeVisible();
    await expect(gate.page.getByTestId('gate-identity')).toBeVisible();
    await expect(gate.page.getByTestId('prestart-team')).toContainText('#001');
    await expect(gate.page.getByTestId('prestart-checklist')).toBeVisible();
    await expect(gate.page.getByTestId('prestart-duration')).toContainText('05:00');
    // The dominant START wears the ember CTA, and its label names the
    // configured duration — the one the round will snapshot.
    const start = gate.page.getByTestId('primary-action');
    await expect(start).toHaveText('BẮT ĐẦU');
    await expect(start).toHaveClass(/cta-ember/);
    // §7: unauthorised roles get no START of their own, and each says so in its
    // own role's voice. Floor 2 has already pressed, so it no longer shows a
    // control at all — V3.4 Role 02 replaced that lock with a read-only summary.
    // NPC 2, which owns nothing here, still reads the disabled lock.
    await expect(corridor.page.getByTestId('r02-handoff-summary')).toBeVisible();
    await expect(corridor.page.getByTestId('r02-confirmed')).toHaveText('ĐÃ XÁC NHẬN ĐỘI ĐẾN TẦNG 2');
    await expect(corridor.page.getByTestId('waiting-state')).toHaveCount(0);
    await expect(corridor.page.getByTestId('primary-action')).toHaveCount(0);
    await expect(room.page.getByTestId('waiting-state')).toContainText('ĐỘI CHƠI SẮP BẮT ĐẦU');
    await expect(room.page.getByTestId('waiting-state')).toHaveAttribute('data-unavailable', '1');
    await expect(room.page.getByTestId('primary-action')).toHaveCount(0);
    await shot(gate.page, 'npc1-screenA-prestart');

    /* ---------------------------------------------------------- Screen B */
    await start.click();
    await expect(gate.page.getByTestId('countdown-screen')).toBeVisible();
    await expect(gate.page.getByTestId('hero-clock')).toHaveText(/^0[45]:\d\d/);
    await expect(gate.page.getByTestId('countdown-status')).toContainText('ĐANG CHẠY');
    // The hundredths are a stated fraction, not a stray number.
    await expect(gate.page.getByTestId('hero-fraction')).toHaveText(/^\.\d\d$/);
    // Running digits read ember, never the old corporate green.
    await expect(gate.page.getByTestId('hero-clock')).toHaveCSS('color', EMBER);
    // The meter is the authoritative remaining share, between 0 and 100 %.
    const meterWidth = await gate.page.locator('[data-testid="countdown-meter"] > span').evaluate((el) => el.clientWidth);
    const meterFull = await gate.page.getByTestId('countdown-meter').evaluate((el) => el.clientWidth);
    expect(meterWidth).toBeGreaterThan(0);
    expect(meterWidth).toBeLessThanOrEqual(meterFull);
    // The lock holds: no navigation, no duration editing, no second START.
    await expect(gate.page.getByTestId('open-details')).toHaveCount(0);
    await expect(gate.page.getByTestId('journey-strip')).toHaveCount(0);
    await shot(gate.page, 'npc1-screenB-countdown');

    // START happened exactly once — the press is not duplicated by retries.
    const started = await snapshotOf(sup);
    expect(started.log.filter((l) => l.action === 'START_GAME')).toHaveLength(1);
    expect(started.active_round?.started_by_role).toBe('GATE');
    expect(started.active_round?.round_duration_ms).toBe(300_000);

    /* ---------------------------------------------------------- Screen C */
    await gate.page.getByTestId('countdown-big').click();
    await expect(gate.page.getByTestId('big-screen')).toBeVisible();
    await expect(gate.page.getByTestId('big-team')).toContainText('· 05:00');
    await expect(gate.page.getByTestId('big-state')).toHaveText('ĐANG CHẠY');
    await expect(gate.page.getByTestId('big-clock')).toHaveCSS('color', EMBER);
    expect(await gate.page.getByTestId('big-clock').evaluate((el) => getComputedStyle(el).color)).not.toBe(OLD_GREEN);
    await expect(gate.page.getByTestId('big-fraction')).toHaveText(/^\.\d\d$/);
    // The wall matches the phone: the same derived clock, within one second.
    const wallSec = clockSeconds(await gate.page.getByTestId('big-clock').textContent());
    const phoneSec = clockSeconds(await gate.page.getByTestId('hero-clock').textContent());
    expect(Math.abs(wallSec - phoneSec)).toBeLessThanOrEqual(1);
    // Utility band: the four legitimate controls, none of them a clock control.
    await expect(gate.page.getByTestId('big-focus')).toHaveText('CHỮ SỐ TO');
    await expect(gate.page.getByTestId('big-full')).toHaveText('TOÀN MÀN HÌNH');
    const mute = gate.page.getByTestId('big-mute');
    await expect(mute).toHaveAccessibleName('Tắt âm thanh');
    await expect(mute).toHaveAttribute('data-active', '0');
    await mute.click();
    await expect(mute).toHaveAccessibleName('Bật âm thanh');
    await expect(mute).toHaveAttribute('data-active', '1');
    await expect(gate.page.getByTestId('big-close')).toHaveText('ĐÓNG');
    await expect(gate.page.getByTestId('big-pause')).toHaveCount(0);
    await expect(gate.page.getByTestId('big-reset')).toHaveCount(0);
    // Digits-only mode is reversible with one tap.
    await gate.page.getByTestId('big-focus').click();
    await expect(gate.page.getByTestId('big-screen')).toHaveAttribute('data-digits-only', 'true');
    await gate.page.getByTestId('big-screen').click();
    await expect(gate.page.getByTestId('big-controls')).toBeVisible();
    await shot(gate.page, 'npc1-screenC-wall');
    await gate.page.getByTestId('big-close').click();
    await expect(gate.page.getByTestId('big-screen')).toBeHidden();
    // Opening and closing the wall never restarted the clock.
    await expect(gate.page.getByTestId('hero-clock')).toHaveText(/^0[45]:\d\d/);

    // The wall on a real large display: same contract, desktop scale.
    const desk = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const deskGate = await signIn(desk, 'gate');
    await expect(deskGate.getByTestId('countdown-screen')).toBeVisible();
    await deskGate.getByTestId('countdown-big').click();
    await expect(deskGate.getByTestId('big-screen')).toBeVisible();
    const wallPx = await deskGate.getByTestId('big-clock').evaluate((el) => parseFloat(getComputedStyle(el).fontSize));
    const phonePx = await deskGate.getByTestId('hero-clock').evaluate((el) => parseFloat(getComputedStyle(el).fontSize));
    expect(wallPx).toBeGreaterThan(phonePx * 2);
    await shot(deskGate, 'npc1-screenC-wall-desktop');
    await deskGate.keyboard.press('Escape');
    await desk.close();

    /* -------------------------------------- warning → danger → expiry */
    const token = await supToken(sup.page);
    // Into the configured last minute: both surfaces cross to the warn tone
    // at the same threshold.
    await sup.context.request.post('/api/dev/clock', { data: { advance_ms: 4 * 60_000 + 10_000 }, headers: { authorization: `Bearer ${token}` } });
    await expect(gate.page.getByTestId('countdown-screen')).toHaveAttribute('data-tone', 'warn');
    // …and the shared design decision behind the colour is the same stage.
    await expect(gate.page.getByTestId('countdown-hero').locator('.countdown-main')).toHaveAttribute('data-stage', 'warn');
    // Past the deadline: frozen at 00:00 in blood, never negative, never green.
    await sup.context.request.post('/api/dev/clock', { data: { advance_ms: 70_000 }, headers: { authorization: `Bearer ${token}` } });
    await expect(gate.page.getByTestId('hero-clock')).toHaveText('00:00');
    await expect(gate.page.getByTestId('countdown-label')).toHaveText('HẾT GIỜ');
    await expect(gate.page.getByTestId('hero-clock')).toHaveCSS('color', BLOOD);
    await expect(gate.page.getByTestId('countdown-hero').locator('.countdown-main')).toHaveAttribute('data-stage', 'danger');
    await gate.page.getByTestId('countdown-big').click();
    await expect(gate.page.getByTestId('big-screen')).toHaveClass(/alarm-glow/);
    await expect(gate.page.getByTestId('big-clock')).toHaveText('00:00');
    await expect(gate.page.getByTestId('big-state')).toHaveText('HẾT GIỜ');
    await shot(gate.page, 'npc1-screenC-wall-expired');
    await gate.page.getByTestId('big-close').click();
    const expired = await snapshotOf(sup);
    expect(expired.active_round?.game_stopped_at).toBeNull();
    expect(expired.active_round?.official_duration_ms).toBeNull();

    for (const { context } of [lobby, corridor, gate, room, sup]) await context.close();
  });

  test('the guarded early exit keeps its business rules on the redesigned screen', async ({ browser }) => {
    test.setTimeout(180_000);
    const lobby = await phone(browser, 'lobby');
    const corridor = await phone(browser, 'corridor');
    const gate = await phone(browser, 'gate');
    const room = await phone(browser, 'room305');
    const sup = await phone(browser, 'supervisor');
    const pages = [lobby.page, corridor.page, gate.page, room.page, sup.page];
    const res = await sup.context.request.post('/api/dev/reset', { headers: { authorization: `Bearer ${await supToken(sup.page)}` } });
    expect(res.ok()).toBe(true);
    for (const p of pages) await p.reload();
    for (const p of pages) await expect(p.getByTestId('dashboard')).toBeVisible();

    await lobby.page.getByTestId('primary-action').click();
    await corridor.page.getByTestId('primary-action').click();
    await gate.page.getByTestId('primary-action').click();
    await expect(gate.page.getByTestId('countdown-screen')).toBeVisible();

    // Only NPC1 holds the path out; it is separated from the primary band and
    // explains its effect before it can even be opened.
    await expect(room.page.getByTestId('emergency-open')).toHaveCount(0);
    await expect(gate.page.getByTestId('emergency-open')).toBeVisible();
    await expect(gate.page.getByTestId('emergency-hint')).toContainText('Không tạo thời gian thắng');
    await gate.page.getByTestId('emergency-open').click();
    await expect(gate.page.getByTestId('emergency-effect')).toBeVisible();
    await expect(gate.page.getByTestId('emergency-confirm')).toBeDisabled();
    await gate.page.getByTestId('emergency-reason').fill('Khách cần y tế');
    await gate.page.getByTestId('emergency-confirm').click();
    await expect
      .poll(async () => (await snapshotOf(sup)).active_round?.result, { timeout: 20_000 })
      .toBe('ABORTED');
    const aborted = await snapshotOf(sup);
    expect(aborted.active_round?.official_duration_ms).toBeNull();
    expect(aborted.active_round?.exit_reason).toBe('Khách cần y tế');
    await shot(gate.page, 'npc1-early-exit');

    for (const { context } of [lobby, corridor, gate, room, sup]) await context.close();
  });
});
