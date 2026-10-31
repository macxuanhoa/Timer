#!/usr/bin/env node
/**
 * Captures the operator-screen previews committed under shots/ against the
 * self-hosted engine (VITE_BACKEND=local):
 *
 *   node scripts/preview.mjs
 *
 * Runs one team up to the moment the clock is running, then writes:
 *   shots/dashboard-preparing.png  GATE before the first dispatch (390x844)
 *   shots/dashboard-game.png       GATE while the round is timed (390x844)
 *   shots/dashboard-360x640.png    CORRIDOR during that round (360x640)
 */
import { chromium } from '@playwright/test';

const BASE = process.env.PREVIEW_BASE ?? 'http://127.0.0.1:5173';
const SHOTS = 'shots';

const browser = await chromium.launch();
const open = async (station, width, height) => {
  const context = await browser.newContext({
    viewport: { width, height },
    deviceScaleFactor: 2,
    isMobile: true,
    hasTouch: true,
  });
  const page = await context.newPage();
  await page.goto(`${BASE}/?station=${station}`);
  await page.getByTestId('dashboard').waitFor();
  return page;
};

const phone = await open('gate', 390, 844);
const lobby = await open('lobby', 390, 844);
const corridor390 = await open('corridor', 390, 844);
const sup = await open('supervisor', 390, 844);

const token = await sup.evaluate(() => JSON.parse(localStorage.getItem('sc305.session.v1') ?? '{}').token);
await sup.context().request.post(`${BASE}/api/dev/reset`, { headers: { authorization: `Bearer ${token}` } });
for (const page of [phone, lobby, corridor390, sup]) await page.reload();
await phone.getByTestId('dashboard').waitFor();
await phone.waitForTimeout(400);

// Before the first team: the stage waits with the full 5:00 visible.
await phone.screenshot({ path: `${SHOTS}/dashboard-preparing.png` });

// LOBBY dispatches, GATE starts the clock, CORRIDOR reports the hallway.
await lobby.getByTestId('primary-action').click();
await phone.getByTestId('primary-action').click();
await corridor390.getByTestId('primary-action').click();
await phone.waitForTimeout(600);
await phone.screenshot({ path: `${SHOTS}/dashboard-game.png` });

// Same round on a 360x640 phone, from the station that still has to press.
const corridor = await open('corridor', 360, 640);
await corridor.waitForTimeout(600);
await corridor.screenshot({ path: `${SHOTS}/dashboard-360x640.png` });

await browser.close();
console.log('wrote dashboard previews to', SHOTS);
