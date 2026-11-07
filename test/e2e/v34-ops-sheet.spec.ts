import { unlockAdmin } from './lib/admin';
import { expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { mkdirSync } from 'node:fs';

/**
 * V3.4 §1–§5 (UI-08) — the Điều hành group of the details sheet.
 *
 * The interrupted session built the operations selectors and rewired the sheet to
 * render an `OpsTab`, but the component itself was never written, so nothing could
 * be verified. This spec is that verification: the command card answers the shift's
 * questions in order (event state → team on the floor → workflow stage → who is
 * blocked → what to do next), the four duty seats read the authoritative state
 * rather than the last audit line, the layout card mirrors the ONE server
 * permission and legal window, and the technical readout stays folded behind
 * “CHẨN ĐOÁN KỸ THUẬT”. Rendered DOM is checked at 320px, where a Vietnamese
 * sentence has nowhere to hide.
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

async function phone(browser: Browser, which: Phone) {
  const context = await browser.newContext();
  return { context, page: await signIn(context, which) };
}

const shot = async (page: Page, name: string) => {
  mkdirSync('shots', { recursive: true });
  await page.screenshot({ path: `shots/v34-${name}.png` });
};

/** Horizontal overflow, the one measurement a 320px phone cannot fake. */
const overflowOf = (page: Page) =>
  page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);

const openOps = async (page: Page) => {
  // Two entries reach the sheet: the footer button on an unlocked station screen
  // and the header gear, which the organiser keeps while a countdown is locked.
  // Taking whichever one is there is what a person on the floor would do.
  const footer = page.getByTestId('open-details');
  if (await footer.count() > 0) await footer.click();
  else await page.getByTestId('open-settings').click();
  await expect(page.getByTestId('details-sheet')).toBeVisible();
  await expect(page.getByTestId('sheet-tab-ops')).toBeVisible();
};

/**
 * The dashboard keeps rendering under the sheet on purpose, so "visible" is not
 * enough: an element of the sheet is only really readable if it is the topmost
 * thing at its own centre point. Measured, because the journey strip's local
 * z-index once painted straight over the seat cards.
 */
const assertOnTop = async (page: Page, testid: string) => {
  const verdict = await page.evaluate((id) => {
    const el = document.querySelector(`[data-testid="${id}"]`);
    const sheet = document.querySelector('[data-testid="details-sheet"]');
    if (!el || !sheet) return { ok: false, why: 'missing' };
    // The sheet scrolls internally; an element below the fold has no measurable
    // centre point, so bring it to the middle first.
    el.scrollIntoView({ block: 'center' });
    const r = el.getBoundingClientRect();
    const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    return { ok: !!hit && sheet.contains(hit), why: hit ? `${hit.tagName}.${hit.className}`.slice(0, 60) : 'none' };
  }, testid);
  expect(verdict.ok, `${testid} is covered by ${verdict.why}`).toBe(true);
};

/**
 * The four questions, measured against the sheet's own box with its scroll area
 * returned to the top. An element only counts as answered if its whole box sits
 * inside that first viewport: a command centre that needs a scroll to say which
 * team is on the floor is not one. The sheet header is included on purpose — it
 * lives outside the scroll box, so the event verdict stays answered at every
 * scroll position rather than only at the top.
 */
const assertFirstViewportAnswers = async (page: Page, answers: Record<string, string>) => {
  await page.evaluate(() => {
    const box = document.querySelector('[data-testid="details-sheet"] .overflow-y-auto');
    if (box) (box as HTMLElement).scrollTop = 0;
  });
  for (const [testid, question] of Object.entries(answers)) {
    const m = await page.evaluate((id) => {
      const sheet = document.querySelector('[data-testid="details-sheet"]');
      const el = document.querySelector(`[data-testid="${id}"]`);
      if (!sheet || !el) return { found: false, inside: false, top: -1, bottom: -1, view: -1 };
      const b = sheet.getBoundingClientRect();
      const r = el.getBoundingClientRect();
      return {
        found: true,
        inside: r.top >= b.top - 1 && r.bottom <= b.bottom + 1,
        top: Math.round(r.top - b.top),
        bottom: Math.round(r.bottom - b.top),
        view: Math.round(b.height),
      };
    }, testid);
    expect(m.found, `${testid} (${question}) is rendered`).toBe(true);
    expect(m.inside, `${testid} (${question}) outside the first viewport: ${m.top}–${m.bottom} of ${m.view}px`)
      .toBe(true);
  }
};

test.describe.serial('V3.4 §1–§5 — the operations group is the shift command centre', () => {
  test('the FIRST viewport answers the four questions, without scrolling', async ({ browser }) => {
    test.setTimeout(240_000);
    const lobby = await phone(browser, 'lobby');
    const corridor = await phone(browser, 'corridor');
    const gate = await phone(browser, 'gate');
    const room = await phone(browser, 'room305');
    const sup = await phone(browser, 'supervisor');

    const token = (page: Page) =>
      page.evaluate(() => JSON.parse(localStorage.getItem('sc305.session.v1') ?? '{}').token as string);
    const reset = await sup.context.request.post('/api/dev/reset', { headers: { authorization: `Bearer ${await token(sup.page)}` } });
    expect(reset.ok()).toBe(true);
    for (const p of [lobby, corridor, gate, room, sup]) await p.page.reload();
    for (const p of [lobby, corridor, gate, room, sup]) await expect(p.page.getByTestId('dashboard')).toBeVisible();

    // A state that genuinely has something to report: the clock is running and a
    // report awaits NPC 2, so "which roles need attention" has a real answer.
    await lobby.page.getByTestId('primary-action').click();
    await corridor.page.getByTestId('primary-action').click();
    await gate.page.getByTestId('primary-action').click();
    await expect(room.page.getByTestId('countdown-screen')).toBeVisible();
    await room.page.getByTestId('record-claim').click();
    await expect(room.page.getByTestId('verify-card-1')).toBeVisible();

    await openOps(sup.page);
    const answers: Record<string, string> = {
      'sheet-event-state': 'is the event active, waiting or ended',
      'ops-team': 'which team is current or last completed',
      'ops-stage': 'what the workflow phase is',
      'ops-attention': 'which roles require attention',
      'ops-next-action': 'what happens next',
    };
    await assertFirstViewportAnswers(sup.page, answers);

    // The words themselves must answer, not merely be on screen: an empty or
    // placeholder state would pass the geometry check and fail the operator.
    await expect(sup.page.getByTestId('sheet-event-state')).not.toHaveText('');
    await expect(sup.page.getByTestId('ops-stage')).not.toHaveText('');
    await expect(sup.page.getByTestId('ops-team')).toContainText(/#\d{3}/);
    await expect(sup.page.getByTestId('ops-attention-item').first()).toContainText('NPC 2');

    await sup.page.screenshot({ path: 'shots/v34-ops-first-viewport.png' });

    // The same contract on the smallest phone the venue actually uses. A short
    // viewport is where a command card stops being a command card if it is
    // allowed to grow, so the four answers are measured again rather than
    // assumed from the 390px result.
    await sup.page.setViewportSize({ width: 320, height: 640 });
    await assertFirstViewportAnswers(sup.page, answers);
    await sup.page.screenshot({ path: 'shots/v34-ops-first-viewport-320.png' });

    for (const { context } of [lobby, corridor, gate, room, sup]) await context.close();
  });

  test('command card, duty seats, layout permission and folded diagnostics, at every width', async ({ browser }) => {
    test.setTimeout(240_000);
    const sup = await phone(browser, 'supervisor');
    const lobby = await phone(browser, 'lobby');
    const corridor = await phone(browser, 'corridor');
    const gate = await phone(browser, 'gate');
    const pages = [sup.page, lobby.page, corridor.page, gate.page];

    const res = await sup.context.request.post('/api/dev/reset', {
      headers: { authorization: `Bearer ${await supToken(sup.page)}` },
    });
    expect(res.ok()).toBe(true);
    for (const p of pages) await p.reload();
    for (const p of pages) await expect(p.getByTestId('dashboard')).toBeVisible();

    // §3: before any team is received, the header and the card both state the
    // event state — never a round tally.
    await openOps(lobby.page);
    await expect(lobby.page.getByTestId('sheet-event-state')).toHaveText('CHƯA MỞ SỰ KIỆN');
    await expect(lobby.page.getByTestId('sheet-event-name')).toBeVisible();
    await expect(lobby.page.getByTestId('ops-command')).toBeVisible();
    await expect(lobby.page.getByTestId('ops-round-counts')).toContainText('0 lượt đã ghi nhận');
    await expect(lobby.page.getByTestId('ops-open-report')).toBeVisible();
    await expect(lobby.page.getByTestId('sheet-big-screen')).toHaveCount(0);
    await shot(lobby.page, 'ops-sheet-before-event');

    // A team is received and handed up: the card follows the authoritative flow.
    await lobby.page.getByTestId('close-details').click();
    await lobby.page.getByTestId('primary-action').click();
    await expect.poll(async () => (await snapshotOf(sup)).active_round?.status, { timeout: 20_000 }).toBe('WAITING_FLOOR2_CONFIRMATION');

    await openOps(gate.page);
    await expect(gate.page.getByTestId('sheet-event-state')).toHaveText('SỰ KIỆN ĐANG DIỄN RA');
    // V3.4 §1: the verdict is stated ONCE. The card answers what the header does
    // not — stage, team, physical position — instead of repeating the same words
    // one row below them.
    await expect(gate.page.getByTestId('ops-command')).not.toContainText('SỰ KIỆN ĐANG DIỄN RA');
    await expect(gate.page.getByTestId('ops-team')).toContainText('#001');
    await expect(gate.page.getByTestId('ops-where')).toContainText('TẦNG');
    // The next action names a person and their press, never a role key.
    const next = gate.page.getByTestId('ops-next-action');
    await expect(next).toContainText('NHÂN SỰ 02');
    await expect(next).not.toContainText('CORRIDOR');
    // Nothing is blocked yet: a stall only becomes an attention item after
    // stall_warn_ms (60 s), so an empty list is the honest answer right now.
    await expect(gate.page.getByTestId('ops-attention')).toHaveCount(0);
    // The reset checklist is not a live question yet, so the sheet must not show
    // three rows of “chờ xác nhận” for a round that has not started its reset.
    await expect(gate.page.getByTestId('ops-reset-tasks')).toHaveCount(0);
    // Nothing from the dashboard underneath may sit on top of the sheet's own
    // content — the collision the seat cards used to have with the journey strip.
    for (const id of ['ops-command', 'section-ops-seats', 'ops-seat-lobby', 'ops-seat-room305', 'ops-layout', 'section-ops-sync']) {
      await assertOnTop(gate.page, id);
    }

    // Four duty seats, each with its own state word and an honest seat claim.
    for (const role of ['lobby', 'corridor', 'gate', 'room305']) {
      const card = gate.page.getByTestId(`ops-seat-${role}`);
      await expect(card).toBeVisible();
      await expect(card.getByTestId(`ops-seat-${role}-state`)).not.toHaveText('');
      // The local demo engine keeps no multi-device seat board, so the card must
      // not claim a seat is empty or held: it says it cannot verify.
      await expect(card.getByTestId(`ops-seat-${role}-seat`)).toContainText('CHƯA XÁC MINH ĐƯỢC GHẾ');
    }
    // V3.4 §1: the station strip is gone from this tab — it repeated the four
    // cards stacked directly below it and truncated its own labels at 320px. The
    // one fact it uniquely carried is still here, in words, on this phone's own
    // card and nowhere else.
    await expect(gate.page.getByTestId('station-strip')).toHaveCount(0);
    await expect(gate.page.getByTestId('ops-seat-gate')).toHaveAttribute('data-self', '1');
    await expect(gate.page.getByTestId('ops-seat-gate').getByTestId('ops-seat-self')).toHaveText('· máy này');
    await expect(gate.page.getByTestId('ops-seat-lobby')).toHaveAttribute('data-self', '0');
    await expect(gate.page.getByTestId('ops-seat-self')).toHaveCount(1);
    // And the command card no longer restates the sheet header's event name.
    await expect(gate.page.getByTestId('ops-command')).not.toContainText('Room 305');

    // §4: the layout card mirrors the server permission. ROOM305 owns the props
    // here, so NPC 2 gets the press and NPC 1 gets the reason it has none.
    await expect(gate.page.getByTestId('ops-layout')).toContainText('NPC 2');
    await expect(gate.page.getByTestId('layout-A')).toHaveCount(0);
    await expect(gate.page.getByTestId('ops-layout-locked')).toContainText('Chỉ');

    // §5: connection in human words first, the technical metrics behind a
    // disclosure that starts closed.
    await expect(gate.page.getByTestId('ops-sync-state')).toBeVisible();
    await expect(gate.page.getByTestId('connectivity')).toBeHidden();
    await gate.page.getByTestId('ops-tech-details').locator('summary').click();
    await expect(gate.page.getByTestId('connectivity')).toBeVisible();
    await expect(gate.page.getByTestId('recheck-connection')).toBeVisible();
    await shot(gate.page, 'ops-sheet-live');

    // The report shortcut moves the same sheet; no second CTA stack appears.
    await gate.page.getByTestId('ops-open-report').click();
    await expect(gate.page.getByTestId('section-rounds')).toBeVisible();

    // A non-supervisor never gets the admin group, a supervisor does.
    await expect(gate.page.getByTestId('sheet-tab-admin')).toHaveCount(0);
    await openOps(sup.page);
    await expect(sup.page.getByTestId('sheet-tab-admin')).toBeVisible();
    await sup.page.getByTestId('close-details').click();

    // Width sweep: the sheet must fit every phone without sideways overflow.
    for (const width of [320, 360, 390, 430]) {
      const context = await browser.newContext({ viewport: { width, height: 640 } });
      const p = await signIn(context, 'gate');
      await openOps(p);
      expect(await overflowOf(p), `ops sheet overflows at ${width}px`).toBeLessThanOrEqual(0);
      await expect(p.getByTestId('ops-command')).toBeVisible();
      if (width === 320) await shot(p, 'ops-sheet-320');
      await context.close();
    }

    for (const { context } of [sup, lobby, corridor, gate]) await context.close();
  });
});

/** Helpers that need the page handle before the test body reads better. */
async function supToken(sup: Page): Promise<string> {
  return sup.evaluate(() => JSON.parse(localStorage.getItem('sc305.session.v1') ?? '{}').token as string);
}

async function snapshotOf(sup: { page: Page; context: BrowserContext }) {
  const res = await sup.context.request.get('/api/snapshot', {
    headers: { authorization: `Bearer ${await supToken(sup.page)}` },
  });
  return (await res.json()) as { active_round?: { status?: string } | null };
}
