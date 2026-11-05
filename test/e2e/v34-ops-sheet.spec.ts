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
  await page.getByTestId('open-details').click();
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

test.describe.serial('V3.4 §1–§5 — the operations group is the shift command centre', () => {
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
    await expect(gate.page.getByTestId('ops-command-state')).toHaveText('SỰ KIỆN ĐANG DIỄN RA');
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
    await expect(gate.page.getByTestId('station-strip')).toBeVisible();

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
