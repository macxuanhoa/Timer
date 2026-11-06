import { expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { mkdirSync } from 'node:fs';

/**
 * V3.4 §3–§4 (UI-03) — NPC 1's three surfaces as ONE timing and presentation contract.
 *
 * `countdown-design.test.ts` pins the mapping inside the module and
 * `v34-npc1-countdown.spec.ts` walks the happy path. What was never proven is
 * the part the brief calls STRICT: that a second tap cannot start a second
 * clock, that the duration a round runs on is the one frozen at START even if
 * somebody edits the configuration mid-round, that a reconnect cannot reset the
 * digits, and that the phone, the wall and the anonymous viewer all show the
 * same instant in the same colour. The viewer used to keep a private palette
 * whose "running" entry was the V3.2 jade — so "same colour" is asserted here,
 * in the browser, where a divergence would actually be seen.
 */

type Phone = 'lobby' | 'corridor' | 'gate' | 'room305' | 'supervisor' | 'observer';

const ROLE_TAG: Record<Phone, string> = {
  lobby: '01',
  corridor: '02',
  gate: 'NPC 1',
  room305: 'NPC 2',
  supervisor: 'TRỊ',
  observer: 'XEM',
};

async function signIn(context: BrowserContext, which: Phone): Promise<Page> {
  const page = await context.newPage();
  await page.goto(`/?station=${which}`);
  // A viewer has no station band and no operator chrome: its own root is the
  // proof it is live, and it is the surface the palette check below reads.
  if (which === 'observer') {
    await expect(page.getByTestId('observer')).toBeVisible();
    return page;
  }
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

const EMBER = 'rgb(244, 137, 58)';    // COUNTDOWN_TONE.ok
const AMBER = 'rgb(255, 180, 69)';    // COUNTDOWN_TONE.warn
const BONE = 'rgb(230, 184, 119)';    // COUNTDOWN_TONE.frozen
const OLD_GREEN = 'rgb(31, 185, 110)'; // the V3.2 stopwatch colour that must not return

/** MM:SS as rendered, to whole seconds. */
const secs = (text: string | null): number => {
  const m = /^(\d\d):(\d\d)/.exec((text ?? '').trim());
  return m ? Number(m[1]) * 60 + Number(m[2]) : Number.NaN;
};

test.describe.serial('V3.4 §3–§4 — one countdown, one palette, four stages', () => {
  test('START is single, the duration is frozen at START, and every surface agrees', async ({ browser }) => {
    test.setTimeout(300_000);
    const lobby = await phone(browser, 'lobby');
    const corridor = await phone(browser, 'corridor');
    const gate = await phone(browser, 'gate');
    const room = await phone(browser, 'room305');
    const sup = await phone(browser, 'supervisor');
    const viewer = await phone(browser, 'observer');
    const pages = [lobby.page, corridor.page, gate.page, room.page, sup.page, viewer.page];

    const reset = await sup.context.request.post('/api/dev/reset', { headers: { authorization: `Bearer ${await tokenOf(sup.page)}` } });
    expect(reset.ok()).toBe(true);
    for (const p of pages) await p.reload();
    await expect(lobby.page.getByTestId('dashboard')).toBeVisible();
    await expect(gate.page.getByTestId('dashboard')).toBeVisible();
    await expect(viewer.page.getByTestId('observer')).toBeVisible();

    const snapshot = async () => {
      const res = await sup.context.request.get('/api/snapshot', { headers: { authorization: `Bearer ${await tokenOf(sup.page)}` } });
      return (await res.json()) as {
        active_round?: {
          game_started_at?: number | null; deadline_at?: number | null; round_duration_ms?: number | null;
          status?: string; result?: string; official_duration_ms?: number | null;
        } | null;
        log?: { action: string }[];
      };
    };
    const advance = async (ms: number) => {
      const r = await sup.context.request.post('/api/dev/clock', {
        data: { advance_ms: ms },
        headers: { authorization: `Bearer ${await tokenOf(sup.page)}` },
      });
      expect(r.ok()).toBe(true);
    };

    await lobby.page.getByTestId('primary-action').click();
    await corridor.page.getByTestId('primary-action').click();

    /* ------------------------------------ unauthorised START, everywhere else */
    const start = gate.page.getByTestId('primary-action');
    await expect(start).toHaveText('BẮT ĐẦU TRÒ CHƠI — 05:00');
    for (const p of [lobby.page, corridor.page, room.page, sup.page]) {
      await expect(p.getByTestId('primary-action')).toHaveCount(0);
    }
    // The viewer renders no control at all, whatever the phase.
    await expect(viewer.page.getByTestId('primary-action')).toHaveCount(0);

    /* ------------------------------------------------- PRE-START, screen A */
    await expect(gate.page.getByTestId('prestart-alert')).toBeVisible();
    await expect(gate.page.getByTestId('prestart-duration')).toContainText('05:00');
    await expect(gate.page.getByTestId('prestart-checklist')).toBeVisible();
    // No oversized inactive countdown: the pre-start band is a card, not a clock
    // stage, and the digits only become dominant once the deadline exists.
    await expect(gate.page.getByTestId('countdown-screen')).toHaveCount(0);
    await shot(gate.page, 'npc1-contract-prestart');

    /* ------------------------------------ START once: a double tap is one write */
    await start.dblclick();
    await expect(gate.page.getByTestId('countdown-screen')).toBeVisible({ timeout: 20_000 });
    const started = await snapshot();
    expect((started.log ?? []).filter((l) => l.action === 'START_GAME')).toHaveLength(1);
    expect(started.active_round?.round_duration_ms).toBe(300_000);
    expect(started.active_round?.deadline_at).toBe((started.active_round?.game_started_at ?? 0) + 300_000);

    /* ---------------------------------------------- stage: ok (ember, live) */
    await expect(gate.page.getByTestId('hero-clock')).toHaveText(/^0[45]:\d\d$/);
    await expect(gate.page.getByTestId('countdown-hero').locator('.countdown-main')).toHaveAttribute('data-stage', 'ok');
    await expect(gate.page.getByTestId('hero-clock')).toHaveCSS('color', EMBER);
    // The hundredths are a stated fraction, not a stray number.
    await expect(gate.page.getByTestId('hero-fraction')).toHaveText(/^\.\d\d$/);
    await shot(gate.page, 'npc1-contract-running');

    /* ------------------------------- the viewer agrees on colour and instant */
    const gateSecs = secs(await gate.page.getByTestId('hero-clock').textContent());
    await expect(viewer.page.getByTestId('observer-clock')).toHaveText(/^0[45]:\d\d$/);
    const viewerSecs = secs(await viewer.page.getByTestId('observer-clock').textContent());
    expect(Math.abs(viewerSecs - gateSecs)).toBeLessThanOrEqual(1);
    const viewerColour = await viewer.page.getByTestId('observer-clock').evaluate((el) => getComputedStyle(el).color);
    expect(viewerColour, 'the viewer must not keep a private countdown palette').toBe(EMBER);
    expect(viewerColour).not.toBe(OLD_GREEN);
    // The presence dot agrees with the word beside it: live is jade, never the
    // blood-red that used to mean both "watching" and "disconnected".
    await expect(viewer.page.getByTestId('observer-dot')).toHaveClass(/bg-jade/);
    await shot(viewer.page, 'observer-contract-running');

    /* ------------------------------------------- the wall is the same clock */
    await gate.page.getByTestId('countdown-big').click();
    await expect(gate.page.getByTestId('big-screen')).toBeVisible();
    await expect(gate.page.getByTestId('big-team')).toContainText('· 05:00');
    const wallSecs = secs(await gate.page.getByTestId('big-clock').textContent());
    expect(Math.abs(wallSecs - gateSecs)).toBeLessThanOrEqual(1);
    await expect(gate.page.getByTestId('big-clock')).toHaveCSS('color', EMBER);
    await expect(gate.page.getByTestId('big-screen').locator('.wall-main')).toHaveAttribute('data-stage', 'ok');
    // No gameplay command exists on the wall. The phone's own controls stay in
    // the DOM behind the overlay, so the check is scoped to the wall surface:
    // its only buttons are the four view controls, and it carries no action
    // attribute at all, because an action attribute is what reaches the RPC.
    const wallButtons = await gate.page.locator('[data-testid="big-screen"] button').evaluateAll(
      (els) => els.map((e) => e.getAttribute('data-testid') ?? '').filter(Boolean).sort(),
    );
    expect(wallButtons).toEqual(['big-close', 'big-focus', 'big-full', 'big-mute']);
    expect(await gate.page.locator('[data-testid="big-screen"] [data-action]').count()).toBe(0);
    await shot(gate.page, 'wall-contract-running');
    await gate.page.keyboard.press('Escape');
    await expect(gate.page.getByTestId('big-screen')).toBeHidden();

    /* ------------------------------- a mid-round edit cannot move this round */
    // The UI offers no path to the duration editor while the clock is locked:
    // every phone is on the countdown surface, and the sheet is not reachable.
    for (const p of [gate.page, sup.page, room.page]) {
      await expect(p.getByTestId('open-details')).toHaveCount(0);
    }
    // And even a configuration that reaches the authority mid-round cannot
    // rewrite the duration this round snapshotted at START. The command carries
    // its expected revision, because the engine refuses one that does not — the
    // refusal is part of the guard, not an inconvenience to work around.
    const current = await sup.context.request.get('/api/snapshot', { headers: { authorization: `Bearer ${await tokenOf(sup.page)}` } });
    const revision = ((await current.json()) as { revision: number }).revision;
    const cfg = await sup.context.request.post('/api/command', {
      data: {
        action: 'CONFIGURE',
        meta: { game_limit_ms: 540_000 },
        idempotency_key: `mid-round-${Date.now()}`,
        expected_revision: revision,
      },
      headers: { authorization: `Bearer ${await tokenOf(sup.page)}` },
    });
    expect(cfg.ok()).toBe(true);
    await expect.poll(async () => (await snapshot()).active_round?.round_duration_ms, { timeout: 20_000 }).toBe(300_000);
    const midEdit = await snapshot();
    expect(midEdit.active_round?.deadline_at).toBe((midEdit.active_round?.game_started_at ?? 0) + 300_000);
    await expect(gate.page.getByTestId('countdown-team')).toContainText('ĐỘI');
    await expect(gate.page.getByTestId('hero-clock')).toHaveText(/^0[43]:\d\d$/);

    /* --------------------------------- reconnect must not reset or restart it */
    const beforeDrop = secs(await gate.page.getByTestId('hero-clock').textContent());
    await gate.page.context().setOffline(true);
    for (let i = 0; i < 30; i++) {
      const s = await gate.page.getByTestId('connection').getAttribute('data-status');
      if (s !== 'CONNECTED') break;
      await gate.page.waitForTimeout(1_000);
    }
    await expect(gate.page.getByTestId('connection')).not.toHaveAttribute('data-status', 'CONNECTED', { timeout: 5_000 });
    await gate.page.context().setOffline(false);
    await expect(gate.page.getByTestId('connection')).toHaveAttribute('data-status', 'CONNECTED', { timeout: 40_000 });
    await expect(gate.page.getByTestId('countdown-screen')).toBeVisible();
    const afterReconnect = secs(await gate.page.getByTestId('hero-clock').textContent());
    // The clock is the stored deadline: it continued down, it never jumped back
    // to 05:00 and it never froze at the moment the socket dropped.
    expect(afterReconnect, 'reconnect reset the countdown').toBeLessThan(beforeDrop);
    expect(afterReconnect).toBeGreaterThan(0);
    expect((await snapshot()).active_round?.game_started_at).toBe(started.active_round?.game_started_at);

    /* --------------------------------------------------- stage: warn (amber) */
    await advance(4 * 60_000 + 10_000);
    // A dev-clock jump is not a revision, so no hint reaches the phone: the new
    // instant arrives on the next periodic re-anchor of the server-clock
    // estimate. That is the honest latency of "no local timer", so the wait is
    // generous while the assertion itself stays exact.
    await expect(gate.page.getByTestId('countdown-hero').locator('.countdown-main')).toHaveAttribute('data-stage', 'warn', { timeout: 40_000 });
    await expect(gate.page.getByTestId('hero-clock')).toHaveCSS('color', AMBER, { timeout: 10_000 });
    await shot(gate.page, 'npc1-contract-warn');

    /* -------------------------- stage: frozen, on a claim validated in time */
    // An in-time announcement is still judgeable after the deadline; here it is
    // judged before, and the digits stop being live information and become the
    // official number the server stored.
    await room.page.getByTestId('record-claim').click();
    await room.page.getByTestId('attempt-valid-1').click();
    await room.page.getByTestId('attempt-valid-1').click();
    await expect.poll(async () => (await snapshot()).active_round?.result, { timeout: 20_000 }).toBe('WON');
    await expect(gate.page.getByTestId('countdown-hero').locator('.countdown-main')).toHaveAttribute('data-stage', 'frozen', { timeout: 40_000 });
    await expect(gate.page.getByTestId('hero-clock')).toHaveCSS('color', BONE, { timeout: 10_000 });
    await expect(gate.page.getByTestId('hero-clock')).not.toHaveCSS('color', OLD_GREEN);
    await expect(gate.page.getByTestId('hero-clock')).toHaveAttribute('data-mode', 'RESULT');
    // The official number is the stored one, echoed — not a stopwatch reading.
    const official = (await snapshot()).active_round?.official_duration_ms ?? 0;
    expect(official).toBeGreaterThan(0);
    expect(official).toBeLessThanOrEqual(300_000);
    await expect(gate.page.getByTestId('countdown-label')).toHaveText('THỜI GIAN HOÀN THÀNH');
    await shot(gate.page, 'npc1-contract-frozen');

    for (const { context } of [lobby, corridor, gate, room, sup, viewer]) await context.close();
  });
});
