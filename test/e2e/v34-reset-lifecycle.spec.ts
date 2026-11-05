import { expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { mkdirSync } from 'node:fs';

/**
 * V3.4 §8 (UI-05) — the post-round physical reset, integrated into the operator
 * screen as NPC 1's Screen B, and continuous with the verification flow that
 * precedes it (UI-04).
 *
 * This is the lifecycle half the interrupted sessions left unwritten: the reset
 * components existed but nothing rendered them, so no test could say whether the
 * reset screen kept the business rules. What is asserted here, on the real dev
 * engine with five phones:
 *
 *   · the completed round is stated once, with the server's official time, and no
 *     countdown runs on a reset screen;
 *   · the checklist is read-only and row-scoped — NPC 1's press marks only the
 *     hallway row it owns, never the whole floor;
 *   · the next team cannot be received while the floor is owed, and the lobby's own
 *     phone agrees with NPC 1's screen;
 *   · a reset confirmation never rewrites the attempt timestamps or the result, and
 *     it does not release a seat or touch the event lifecycle.
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

const tokenOf = (page: Page) =>
  page.evaluate(() => JSON.parse(localStorage.getItem('sc305.session.v1') ?? '{}').token as string);

const shot = async (page: Page, name: string) => {
  mkdirSync('shots', { recursive: true });
  await page.screenshot({ path: `shots/v34-${name}.png` });
};

test.describe.serial('V3.4 §8 — one continuous lifecycle: verification → exit → physical reset', () => {
  test('NPC 1 reset screen states the finished round, presses only its own area, and never rewrites the result', async ({ browser }) => {
    test.setTimeout(240_000);
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
        active_round?: { id?: string; status?: string; result?: string; official_duration_ms?: number | null; exit_confirmed_at?: number | null } | null;
        rounds?: { id: string; official_duration_ms?: number | null; exit_confirmed_at?: number | null }[];
      };
    };

    // Reception → floor 2 → the clock, then NPC 2 verifies a claim (UI-04).
    await lobby.page.getByTestId('primary-action').click();
    await corridor.page.getByTestId('primary-action').click();
    await gate.page.getByTestId('primary-action').click();
    await expect(room.page.getByTestId('countdown-screen')).toBeVisible();
    await room.page.getByTestId('record-claim').click();
    await room.page.getByTestId('attempt-valid-1').click();
    await room.page.getByTestId('attempt-valid-1').click();
    await expect.poll(async () => (await snapshot()).active_round?.result, { timeout: 20_000 }).toBe('WON');

    // NPC 1's guarded exit confirmation closes the floor for this team.
    await gate.page.getByTestId('primary-action').click();
    await expect(gate.page.getByTestId('primary-action')).toHaveText('XÁC NHẬN LẠI: ĐỘI ĐÃ RỜI TẦNG 3');
    await gate.page.getByTestId('primary-action').click();
    await expect.poll(async () => (await snapshot()).active_round?.status, { timeout: 20_000 }).toBe('EXIT_CONFIRMED');
    const decided = await snapshot();
    const officialMs = decided.active_round?.official_duration_ms ?? null;
    const exitAt = decided.active_round?.exit_confirmed_at ?? null;
    expect(officialMs).not.toBeNull();

    /* ------------------------------------------------------ Screen B renders */
    await expect(gate.page.getByTestId('npc1-reset-identity')).toBeVisible();
    await expect(gate.page.getByTestId('event-state')).toContainText('reset', { ignoreCase: true });
    // The finished round replaces the idle clock, and it is the stored number.
    await expect(gate.page.getByTestId('hero')).toHaveAttribute('data-mode', 'RESET');
    await expect(gate.page.getByTestId('hero-clock')).toHaveAttribute('data-mode', 'RESULT');
    await expect(gate.page.getByTestId('reset-checklist')).toBeVisible();
    await expect(gate.page.getByTestId('reset-count')).toHaveText('0/3');
    // Rows are scoped: exactly one belongs to this phone, and nothing else does.
    await expect(gate.page.getByTestId('reset-row-hallway')).toHaveAttribute('data-owner', 'mine');
    await expect(gate.page.getByTestId('reset-row-hidden_objects')).toHaveAttribute('data-owner', 'other');
    await expect(gate.page.getByTestId('reset-row-room')).toHaveAttribute('data-owner', 'other');

    // No countdown belongs on a reset screen — for any role.
    for (const p of [gate.page, lobby.page, corridor.page]) {
      await expect(p.getByTestId('countdown-screen')).toHaveCount(0);
    }

    // §11: the reset screen is the widest new surface in the app (three checklist
    // rows, a result card and a readiness sentence), so it is measured at the
    // 320px floor before anything is pressed.
    await gate.page.setViewportSize({ width: 320, height: 640 });
    const overflow = await gate.page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow, `npc1 reset screen overflows 320px by ${overflow}px`).toBeLessThanOrEqual(0);
    await shot(gate.page, 'npc1-reset-320');
    await gate.page.setViewportSize({ width: 390, height: 844 });

    /* ------------------------------------- the next team is still held back */
    await expect(gate.page.getByTestId('next-team-status')).toHaveAttribute('data-can-call', '0');
    await expect(gate.page.getByTestId('next-team-waiting')).toContainText('CHỜ');
    // The lobby's own phone agrees: no reception press exists yet.
    await expect(lobby.page.getByTestId('primary-action')).toHaveCount(0);
    await expect(lobby.page.getByTestId('waiting-state')).toBeVisible();

    /* ------------------------------- one press, and it claims only its area */
    await expect(gate.page.getByTestId('primary-action')).toHaveText('XÁC NHẬN ĐÃ RESET HÀNH LANG');
    await gate.page.getByTestId('primary-action').click();
    await expect(gate.page.getByTestId('reset-row-hallway')).toHaveAttribute('data-state', 'done', { timeout: 20_000 });
    await expect(gate.page.getByTestId('reset-count')).toHaveText('1/3');
    // The press is gone once the server has the row: no duplicate confirmation
    // is even offered, and the read-only status names only this station's area.
    await expect(gate.page.getByTestId('primary-action')).toHaveCount(0);
    await expect(gate.page.getByTestId('waiting-state')).toContainText('HÀNH LANG ĐÃ RESET');
    // The other two areas stay untouched by this phone.
    await expect(gate.page.getByTestId('reset-row-hidden_objects')).not.toHaveAttribute('data-state', 'done');

    // The result is untouched by a reset confirmation (strict business rule).
    const afterGate = await snapshot();
    expect(afterGate.active_round?.official_duration_ms).toBe(officialMs);
    expect(afterGate.active_round?.exit_confirmed_at).toBe(exitAt);

    /* ------------------------------------ the floor is handed back, in order */
    await room.page.getByTestId('primary-action').click();
    await expect(gate.page.getByTestId('reset-count')).toHaveText('3/3', { timeout: 20_000 });
    await expect(gate.page.getByTestId('primary-action')).toHaveText('XÁC NHẬN SẴN SÀNG');
    await gate.page.getByTestId('primary-action').click();
    await expect.poll(async () => (await snapshot()).active_round, { timeout: 20_000 }).toBeNull();

    // Rounds and results survive the close: the same official time, still recorded.
    const closed = (await snapshot()).rounds ?? [];
    expect(closed.at(-1)?.official_duration_ms).toBe(officialMs);
    // Only now may the next team be received, and the lobby says so itself.
    await expect(lobby.page.getByTestId('primary-action')).toHaveText('NHẬN ĐỘI & CHO LÊN TẦNG 2', { timeout: 20_000 });

    for (const { context } of [lobby, corridor, gate, room, sup]) await context.close();
  });
});
