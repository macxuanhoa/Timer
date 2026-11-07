#!/usr/bin/env node
/**
 * Captures the V3 operator-screen previews into shots/ (git-ignored) against the
 * self-hosted engine (VITE_BACKEND=local). Bring a fresh dev server up first, then:
 *
 *   npm run dev           # in another terminal, or set PREVIEW_BASE elsewhere
 *   node scripts/preview.mjs
 *
 * One team is run through the real flow, and each screen that §C of the brief
 * asks to be verified is written from the phone that actually owns it:
 *
 *   shots/home-board.png             the picker: four stations + the open seat
 *   shots/dashboard-preparing.png    OPERATOR 01 waiting, everyone else locked
 *   shots/prestart-alert.png         the amber READY AT FLOOR 3 alert (NPC 2)
 *   shots/dashboard-game.png         NPC 1's locked countdown (390x844)
 *   shots/npc2-verification.png      NPC 2's claim/verification panel on the clock
 *   shots/observer-view.png          the read-only viewer during the round
 *   shots/success-waiting-exit.png   the official result and NPC 1's exit control
 *   shots/dashboard-360x640.png      the same round on the smallest phone
 *   shots/time-up.png                a second team's clock held at 00:00
 */
import { chromium } from '@playwright/test';

const BASE = process.env.PREVIEW_BASE ?? 'http://127.0.0.1:5173';
const SHOTS = 'shots';

const browser = await chromium.launch();
const open = async (station, width = 390, height = 844) => {
  const context = await browser.newContext({
    viewport: { width, height },
    deviceScaleFactor: 2,
    isMobile: true,
    hasTouch: true,
  });
  const page = await context.newPage();
  await page.goto(`${BASE}/${station ? `?station=${station}` : ''}`);
  await page.getByTestId(station === 'observer' ? 'observer' : station ? 'dashboard' : 'scream-home').waitFor();
  return page;
};

const primary = page => page.getByTestId('primary-action');
/** Waits for the button to read this before touching it, so a picture never
 *  captures a press meant for the previous phase. */
const press = async (page, label) => {
  const button = primary(page).filter({ hasText: label });
  await button.waitFor();
  await button.click();
};
const shot = (page, name) => page.screenshot({ path: `${SHOTS}/${name}` });

// 1. The picker on a server nobody has claimed yet: four stations plus the seat
//    that asks for no password.
const board = await open(null);
await shot(board, 'home-board.png');
await board.context().close();

const lobby = await open('lobby');
const corridor = await open('corridor');
const gate = await open('gate');
const room = await open('room305');
const sup = await open('supervisor');

// A brand-new session, so nothing from an earlier rehearsal leaks into a picture.
const token = await sup.evaluate(() => JSON.parse(localStorage.getItem('sc305.session.v1') ?? '{}').token);
await sup.context().request.post(`${BASE}/api/dev/reset`, { headers: { authorization: `Bearer ${token}` } });
for (const page of [lobby, corridor, gate, room, sup]) await page.reload();
await lobby.getByTestId('dashboard').waitFor();

// 2. Before the first team: one control on 01's phone, a grey lock everywhere else.
await shot(lobby, 'dashboard-preparing.png');

// 3. Reception, then the floor-2 handover, then the pre-start alert on every phone.
await lobby.getByTestId('team-edit').click();
await lobby.getByTestId('team-name').fill('Ma Tro');
await press(lobby, 'NHẬN ĐỘI');
await press(corridor, 'XÁC NHẬN ĐÃ ĐẾN TẦNG 2');
await room.getByTestId('prestart-alert').waitFor();
await shot(room, 'prestart-alert.png');

// 4. NPC 1 starts the 5:00; every screen is now the countdown.
await press(gate, 'BẮT ĐẦU TRÒ CHƠI');
await gate.getByTestId('countdown-screen').waitFor();
await shot(gate, 'dashboard-game.png');

// 5. NPC 2 records an announcement; the panel keeps its own decision row per lần.
await room.getByTestId('record-claim').click();
await room.getByTestId('attempt-label').waitFor();
await shot(room, 'npc2-verification.png');

// 6. The viewer sees the same clock and nothing else.
const viewer = await open('observer');
await viewer.getByTestId('observer-clock').waitFor();
await shot(viewer, 'observer-view.png');

// 7. A rejected announcement, then the valid one: the score is the claim instant.
await room.getByTestId('attempt-invalid-1').click();
await room.getByTestId('record-claim').waitFor();
await room.getByTestId('record-claim').click();
await room.getByTestId('attempt-valid-2').click();
await room.getByTestId('countdown-official').waitFor();
await gate.getByTestId('countdown-official').waitFor();
await shot(gate, 'success-waiting-exit.png');

// 8. The same round at 360x640 on the phone that has nothing left to press.
const small = await open('corridor', 360, 640);
await shot(small, 'dashboard-360x640.png');
await small.context().close();

// 9. Close this team out, then let a second team's clock simply run out: the
//    display holds at 00:00 and offers no pause, resume or reset anywhere.
await press(gate, 'XÁC NHẬN ĐỘI ĐÃ RỜI TẦNG 3');
await press(gate, 'ĐÃ RESET XONG');
await press(room, 'ĐÃ RESET XONG');
await press(gate, 'XÁC NHẬN SẴN SÀNG');
await lobby.getByTestId('primary-action').waitFor();
await press(lobby, 'NHẬN ĐỘI');
await press(corridor, 'XÁC NHẬN ĐÃ ĐẾN TẦNG 2');
await press(gate, 'BẮT ĐẦU TRÒ CHƠI');
await gate.getByTestId('countdown-screen').waitFor();
await sup.context().request.post(`${BASE}/api/dev/clock`, {
  data: { advance_ms: 300_000 + 15_000 },
  headers: { authorization: `Bearer ${token}` },
});
await gate.getByTestId('hero-clock').filter({ hasText: /^00:00$/ }).waitFor();
await shot(gate, 'time-up.png');

await browser.close();
console.log('wrote V3 previews to', SHOTS);
