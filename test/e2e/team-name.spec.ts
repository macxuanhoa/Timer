import { unlockAdmin } from './lib/admin';
import { expect, test } from '@playwright/test';

/**
 * The pencil is only real if the correction reaches Postgres-grade state rather
 * than this phone's memory: the local dev engine here is the same authoritative
 * path, so another phone (and a reload) must see the new label.
 */
test('team label is persisted and reaches every phone', async ({ browser }) => {
  const lobbyContext = await browser.newContext();
  const gateContext = await browser.newContext();
  const supervisorContext = await browser.newContext();
  const lobby = await lobbyContext.newPage();
  const gate = await gateContext.newPage();
  const supervisor = await supervisorContext.newPage();
  await supervisor.goto('/?station=supervisor');
  await unlockAdmin(supervisor);
  await expect(supervisor.getByTestId('dashboard')).toBeVisible();
  const token = await supervisor.evaluate(() => JSON.parse(localStorage.getItem('sc305.session.v1') ?? '{}').token as string);
  const reset = await supervisorContext.request.post('/api/dev/reset', { headers: { authorization: `Bearer ${token}` } });
  expect(reset.ok()).toBe(true);
  await lobby.goto('/?station=lobby');
  await gate.goto('/?station=gate');
  await expect(lobby.getByTestId('dashboard')).toBeVisible();
  await expect(gate.getByTestId('dashboard')).toBeVisible();

  // A label drafted before the call travels with CALL_TEAM.
  await lobby.getByTestId('team-edit').click();
  await lobby.getByTestId('team-name').fill('Ma Tro');
  await lobby.getByTestId('primary-action').click();
  await expect(gate.getByTestId('team-status')).toContainText('Ma Tro');

  // The pencil now corrects the team already on the floor.
  await lobby.getByTestId('team-edit').click();
  await lobby.getByTestId('team-name').fill('Nhà Búp Bê');
  await lobby.getByTestId('team-name-save').click();
  await expect(lobby.getByTestId('team-status')).toContainText('Nhà Búp Bê');
  await expect(gate.getByTestId('team-status')).toContainText('Nhà Búp Bê');

  // Reloading proves the label came back from the server, not from this tab.
  await gate.reload();
  await expect(gate.getByTestId('dashboard')).toBeVisible();
  await expect(gate.getByTestId('team-status')).toContainText('Nhà Búp Bê');
  await Promise.all([lobbyContext.close(), gateContext.close(), supervisorContext.close()]);
});
