import { unlockAdmin } from './lib/admin';
import { expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test';

/**
 * GĐ6 §4 — Vietnamese rendered-DOM acceptance.
 *
 * Handoff §IV forbids any raw enum / English technical token on the operator
 * surface, and §VII item I says a source-string scan is not enough: the check
 * must look at what actually renders, including error, empty, offline and dialog
 * states. This spec drives five phones + an open viewer through the phases the
 * floor sees, and after every phase it sweeps the rendered text on each phone.
 *
 * It also exercises the V3.1 configurable countdown (02:00) end-to-end so the
 * MM:SS label adapts in the browser, not only in the vitest matrix.
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

/** Every identifier that must never appear in the rendered DOM. */
const RAW_TOKENS = [
  // Action enum
  'CALL_TEAM', 'CONFIRM_FLOOR2', 'FLOOR2_BYPASS', 'START_GAME', 'CLAIM_COMPLETE',
  'VERIFY_ATTEMPT', 'CONFIRM_EXIT', 'EARLY_EXIT', 'RESET_DONE', 'GATE_FINALIZE',
  'SET_LAYOUT', 'SET_TEAM_NAME', 'REOPEN_RESET', 'REVIEW_RESOLVE', 'END_EVENT',
  'OPEN_NEW_EVENT',
  'ABORT_ROUND', 'CORRECT_ROUND', 'CONFIGURE', 'OVERRIDE_ADMIT', 'OVERTIME_STARTED',
  'EVENT_CLOSED', 'SESSION_RESTORE', 'TEAM_UPSTAIRS', 'GAME_PAUSE', 'GAME_RESUME',
  'GAME_RESET', 'HALLWAY_PROGRESS', 'ROOM_REACHED', 'PUZZLE_COMPLETE', 'RETURN_START',
  'GAME_STOP', 'START_EVENT',
  // Role / station enum (the raw keys, not their Vietnamese display names)
  'OPERATOR 01', 'OPERATOR 02', 'OPERATOR_01', 'OPERATOR_02',
  'LOBBY_CALL', 'CORRIDOR_ACTIVE',
  // The four internal role identifiers. Handoff §IV keeps them in the wire format
  // but demands the display layer never spell them: the operator surface must read
  // "NHÂN SỰ 01 · TẦNG 1", "NPC 2 · PHÒNG 305" etc. instead of "LOBBY", "ROOM305".
  // Only ever checking the visible text and aria-label/title, not `data-*`
  // attributes (which Playwright selectors rely on and never reach the eye).
  'LOBBY', 'CORRIDOR', 'ROOM305', 'SUPERVISOR', 'OBSERVER',
  // Round lifecycle enum
  'WAITING_FLOOR2_CONFIRMATION', 'READY_AT_FLOOR3',
  'TIME_EXPIRED_PENDING_VALIDATION', 'WAITING_FOR_EXIT', 'EXIT_CONFIRMED',
  'TEAM_PREPARING', 'GAME_STARTED', 'PUZZLE_COMPLETED', 'GAME_EXITED',
  'RESET_CONFIRMED', 'GATE_CLEARED',
  // Result / attempt enum — the exact uppercase forms the raw state keys use.
  // Note the label layer legitimately renders "CHỜ", "ĐANG CHỜ", "XONG" etc., so
  // we only reject the exact enum string, not every uppercase substring.
  'PENDING_VALIDATION', 'TIME_UP', 'IN_PROGRESS',
  // Reset task keys
  'hidden_objects',
  // Transport state enum
  'CONNECTED', 'SYNCING', 'DEGRADED', 'OFFLINE',
  // Team heading must read ĐỘI, never TEAM
  'TEAM #', 'Team #',
] as const;

async function signIn(context: BrowserContext, phone: Phone): Promise<Page> {
  const page = await context.newPage();
  await page.goto(`/?station=${phone}`);
  if (phone === 'supervisor') await unlockAdmin(page);
  if (phone === 'observer') {
    await expect(page.getByTestId('observer')).toBeVisible();
    return page;
  }
  await expect(page.getByTestId('dashboard')).toBeVisible();
  await expect(page.getByTestId('role-tag')).toHaveText(ROLE_TAG[phone]);
  return page;
}

async function phone(browser: Browser, which: Phone) {
  const context = await browser.newContext();
  return { context, page: await signIn(context, which) };
}

const primary = (page: Page) => page.getByTestId('primary-action');

/**
 * Reads every piece of visible text the operator can see on this page and asserts
 * none of it is a raw technical token. Runs after every phase so a leak in a lock,
 * alert, hint, dialog or history row cannot pass unnoticed.
 */
async function expectVietnamese(page: Page, phase: string): Promise<void> {
  // V3.4 §9: the report tab folds each round card and its diagnostics, and the
  // audit list opens shortened. `innerText` returns visible text only, so the
  // sweep opens every disclosure first — the check therefore covers strictly
  // MORE rendered text than it did before the folds existed, never less.
  await page.evaluate(() => {
    for (const d of Array.from(document.querySelectorAll('details'))) d.open = true;
    const more = document.querySelector('[data-testid="audit-expand"]') as HTMLButtonElement | null;
    more?.click();
  });
  // `inner text` on the body picks up every visible element, and the aria-label
  // attributes carry the label layer too, so we also grab every aria-label / title
  // that a screen reader would speak.
  const [bodyText, ariaLabels] = await Promise.all([
    page.evaluate(() => document.body.innerText),
    page.evaluate(() => Array.from(document.querySelectorAll('[aria-label], [title]'))
      .map((el) => el.getAttribute('aria-label') ?? el.getAttribute('title') ?? '')
      .join('\n')),
  ]);
  const haystack = `${bodyText}\n${ariaLabels}`;
  for (const token of RAW_TOKENS) {
    expect(haystack, `${phase}: rendered DOM leaks raw token "${token}"`).not.toContain(token);
  }
}

async function freshSession(sup: { page: Page; context: BrowserContext }, pages: Page[]) {
  const token = await sup.page.evaluate(
    () => JSON.parse(localStorage.getItem('sc305.session.v1') ?? '{}').token as string,
  );
  const res = await sup.context.request.post('/api/dev/reset', { headers: { authorization: `Bearer ${token}` } });
  expect(res.ok()).toBe(true);
  for (const page of pages) await page.reload();
  for (const page of pages) await expect(page.getByTestId('dashboard')).toBeVisible();
}

/** Supervisor stores a new round duration via the details sheet. */
async function configureDuration(sup: Page, minutes: string, seconds: string) {
  await sup.getByTestId('open-details').click();
  await sup.getByTestId('sheet-tab-admin').click();
  await sup.getByTestId('cfg-duration-min').fill(minutes);
  await sup.getByTestId('cfg-duration-sec').fill(seconds);
  await sup.getByTestId('cfg-save').click();
  await expect(sup.getByTestId('cfg-duration-current')).toContainText(`${minutes}:${seconds}`);
  await sup.getByTestId('close-details').click();
}

test.describe.serial('V3.1 §IV + §7 — Vietnamese rendered DOM & configurable countdown', () => {
  test('sweeps every role screen for raw technical tokens across the full flow', async ({ browser }) => {
    test.setTimeout(180_000);
    const lobby = await phone(browser, 'lobby');
    const corridor = await phone(browser, 'corridor');
    const gate = await phone(browser, 'gate');
    const room = await phone(browser, 'room305');
    const sup = await phone(browser, 'supervisor');
    const viewer = await phone(browser, 'observer');

    // Previous specs in the same run leave the shared engine at a CLOSED round.
    // Reset the event to PRE_EVENT so the sweep starts on a clean lobby screen.
    await freshSession(sup, [lobby.page, corridor.page, gate.page, room.page, sup.page]);
    await viewer.page.reload();
    await expect(viewer.page.getByTestId('observer')).toBeVisible();

    // PRE_EVENT — every phone in the "chưa mở sự kiện" waiting state.
    await expectVietnamese(lobby.page, 'PRE_EVENT: lobby');
    await expectVietnamese(corridor.page, 'PRE_EVENT: corridor');
    await expectVietnamese(gate.page, 'PRE_EVENT: gate');
    await expectVietnamese(room.page, 'PRE_EVENT: room');
    await expectVietnamese(sup.page, 'PRE_EVENT: supervisor');
    await expectVietnamese(viewer.page, 'PRE_EVENT: observer');

    // §7 Reception → floor 2 with a 02:00 round configured, so the START label
    // itself proves the duration is dynamic and not a hard-coded 05:00.
    await configureDuration(sup.page, '02', '00');
    await lobby.page.getByTestId('primary-action').click();
    await expect(lobby.page.getByTestId('waiting-state')).toContainText('ĐÃ CHO ĐỘI LÊN TẦNG 2');
    await expectVietnamese(lobby.page, 'WAITING_FLOOR2_CONFIRMATION: lobby');
    await expectVietnamese(corridor.page, 'WAITING_FLOOR2_CONFIRMATION: corridor');

    await corridor.page.getByTestId('primary-action').click();
    await expect(primary(gate.page)).toHaveText('BẮT ĐẦU');
    await expectVietnamese(gate.page, 'READY_AT_FLOOR3: gate');

    await primary(gate.page).click();
    await expect(gate.page.getByTestId('countdown-status')).toContainText('ĐANG CHẠY 02:00');
    for (const p of [lobby, corridor, gate, room]) {
      await expectVietnamese(p.page, `RUNNING (02:00): ${p.page === lobby.page ? 'lobby' : p.page === corridor.page ? 'corridor' : p.page === gate.page ? 'gate' : 'room'}`);
    }

    // NPC2 records a claim; the label layer keeps the row in Vietnamese.
    await room.page.getByTestId('record-claim').click();
    // V3.4: the pending attempt now lives in its own verification card.
    await expect(room.page.getByTestId('verify-head-1')).toContainText('LẦN 1');
    await expectVietnamese(room.page, 'RUNNING: room (pending claim)');

    // Verify with the wrong decision: label reads `CHƯA ĐÚNG`, never `INVALID`.
    // After the reject the attempt closes, so its decision buttons disappear and the
    // row falls back to its caption — the verdict is the status word and the note
    // says what happened to the reported mark (V3.4.1), so the pair is what a real
    // operator reads and what this sweep must guard.
    await room.page.getByTestId('attempt-invalid-1').click();
    await expect(room.page.getByTestId('attempt-1')).toHaveAttribute('data-status', 'INVALID');
    await expect(room.page.getByTestId('attempt-1')).toContainText('CHƯA ĐÚNG');
    await expect(room.page.getByTestId('attempt-closed')).toContainText('Giữ nguyên mốc báo');
    await expect(room.page.getByTestId('attempt-closed')).not.toContainText('INVALID');
    await expectVietnamese(room.page, 'RUNNING: room (rejected attempt)');

    // NPC2 records and validates a second claim, then NPC1 closes out.
    await room.page.getByTestId('record-claim').click();
    await expect(room.page.getByTestId('attempt-valid-2')).toBeEnabled();
    // V3.4 §5: the finalisation is a deliberate two-press gesture.
    await room.page.getByTestId('attempt-valid-2').click();
    await room.page.getByTestId('attempt-valid-2').click();
    await expect(room.page.getByTestId('countdown-label')).toHaveText('THỜI GIAN HOÀN THÀNH');
    // V3.4 §6: the milestone card replaces the claim CTA on NPC2's phone.
    await expect(room.page.getByTestId('official-result')).toBeVisible();
    await expect(room.page.getByTestId('record-claim')).toHaveCount(0);
    await expectVietnamese(room.page, 'WAITING_FOR_EXIT: room (validated)');
    await expectVietnamese(gate.page, 'WAITING_FOR_EXIT: gate');

    // V3.4 §7: the exit confirmation is armed, then lands.
    await gate.page.getByTestId('primary-action').click();
    await gate.page.getByTestId('primary-action').click();
    await expect(gate.page.getByTestId('hero')).toBeVisible();
    await expectVietnamese(gate.page, 'EXIT_CONFIRMED: gate');

    await gate.page.getByTestId('primary-action').click();
    await expectVietnamese(gate.page, 'RESET (hallway confirmed): gate');
    // Right after NPC 1 has confirmed the hallway, ROOM305 still owes the hidden
    // props and the room. V3.4 §4: the gate's read-only status now names only the
    // area it actually confirmed, so it can never claim the whole floor, while the
    // areas still outstanding stay in the caption's hint. Both must be Vietnamese
    // (`Vật phẩm ẩn`, `Phòng 305`) and never leak the reset task keys.
    await expect(gate.page.getByTestId('waiting-state')).toContainText('HÀNH LANG ĐÃ RESET');
    await expect(gate.page.getByTestId('waiting-state')).not.toHaveText('ĐÃ RESET XONG');
    // The outstanding areas live in the hint tooltip (title attribute) and in the
    // sibling <p> the PrimaryZone renders underneath the locked button. Assert the
    // tooltip on the button itself; the sibling <p> is covered by the sweep below.
    await expect(gate.page.getByTestId('waiting-state')).toHaveAttribute('title', /Vật phẩm ẩn/);
    await expect(gate.page.getByTestId('waiting-state')).toHaveAttribute('title', /Phòng 305/);
    await expect(gate.page.getByTestId('waiting-state')).not.toHaveAttribute('title', /hidden_objects|hallway/);
    // Same content is rendered as a visible paragraph beneath the button: this is
    // the surface the sweep already covers, so assert it once directly too.
    await expect(gate.page.locator('div:has(> [data-testid="waiting-state"])')).toContainText('Vật phẩm ẩn');
    await expect(gate.page.locator('div:has(> [data-testid="waiting-state"])')).not.toContainText('hidden_objects');

    await room.page.getByTestId('primary-action').click();
    await expectVietnamese(room.page, 'RESET (all three done): room');
    // With the checklist complete the gate's finalize control opens: the same
    // predicate the backend enforces, mirrored on the phone (§5.3 UI-guard sync).
    await expect(gate.page.getByTestId('primary-action')).toHaveText('XÁC NHẬN SẴN SÀNG');

    await gate.page.getByTestId('primary-action').click();
    await expectVietnamese(gate.page, 'CLOSED: gate');

    // Supervisor admin sheet: every label the operator may open must be Vietnamese,
    // including the correction form and the release panel. V3.2 IA: scan each tab.
    await sup.page.getByTestId('open-details').click();
    for (const tab of ['sheet-tab-ops', 'sheet-tab-report', 'sheet-tab-admin']) {
      await sup.page.getByTestId(tab).click();
      await expectVietnamese(sup.page, `SUPERVISOR sheet ${tab}`);
    }
    await sup.page.getByTestId('close-details').click();

    // Offline sweep — the DEGRADED/OFFLINE path must show TRANSPORT_LABEL, not the
    // raw enum. `data-status` attribute keeps the technical key (test only), but the
    // visible chip reads the Vietnamese label.
    await sup.page.context().setOffline(true);
    await sup.page.evaluate(() => window.dispatchEvent(new Event('offline')));
    await expect(sup.page.getByTestId('connection')).not.toHaveText('CONNECTED', { timeout: 15_000 });
    const offlineChip = await sup.page.getByTestId('connection').innerText();
    expect(offlineChip).not.toMatch(/OFFLINE|DEGRADED|SYNCING|CONNECTED/);
    await sup.page.context().setOffline(false);

    for (const { context } of [lobby, corridor, gate, room, sup, viewer]) await context.close();
  });
});
