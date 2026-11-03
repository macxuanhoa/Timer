import { describe, expect, it } from 'vitest';
import { TestHub, latest } from './helpers/harness';
import { TEAM_NAME_MAX } from '../src/shared/constants';

/**
 * The pencil next to TEAM #… must be a database-backed command, not a local text
 * box: a correction becomes a revisioned, audited snapshot that every phone
 * adopts. These cases exercise the engine and run independently of the legacy
 * deadline tests.
 */
describe('team label', () => {
  it('is normalised on dispatch, then corrected, cleared and audited', () => {
    const hub = new TestHub();
    expect(hub.command('lobby', 'CALL_TEAM', { team_name: '  Ma   Tro  ' }).ok).toBe(true);
    expect(hub.snapshot().active_round?.team_name).toBe('Ma Tro');

    const before = hub.snapshot().revision;
    expect(hub.command('lobby', 'SET_TEAM_NAME', { team_name: 'Nhà Búp Bê' }).ok).toBe(true);
    expect(hub.snapshot().revision).toBe(before + 1);
    expect(hub.snapshot().active_round?.team_name).toBe('Nhà Búp Bê');
    expect(latest(hub, 'SET_TEAM_NAME')?.metadata).toMatchObject({
      team_name: 'Nhà Búp Bê',
      previous_team_name: 'Ma Tro',
    });

    // SUPERVISOR may correct it too; an explicit empty label clears it.
    expect(hub.command('supervisor', 'SET_TEAM_NAME', { team_name: 'SUP sửa' }).ok).toBe(true);
    expect(hub.command('lobby', 'SET_TEAM_NAME', { team_name: '' }).ok).toBe(true);
    expect(hub.snapshot().active_round?.team_name).toBeNull();
  });

  it('is refused for other stations, stale phones, overlong labels and closed rounds', () => {
    const hub = new TestHub();
    hub.command('lobby', 'CALL_TEAM');
    const before = hub.snapshot().revision;

    expect(hub.command('gate', 'SET_TEAM_NAME', { team_name: 'Gate gán' }).code).toBe('PERMISSION_DENIED');
    expect(hub.command('lobby', 'SET_TEAM_NAME', { team_name: 'Cũ' }, before - 1).code).toBe('STALE_REVISION');
    expect(hub.command('lobby', 'SET_TEAM_NAME', { team_name: 'x'.repeat(TEAM_NAME_MAX + 1) }).code).toBe(
      'INVALID_STATE',
    );
    expect(hub.command('lobby', 'SET_TEAM_NAME', {}).code).toBe('INVALID_STATE');
    expect(hub.snapshot().active_round?.team_name).toBeNull();

    // The label belongs to the handover, not to the game: once 5:00 runs, session
    // data is frozen for every role (§9).
    hub.command('corridor', 'CONFIRM_FLOOR2');
    hub.command('gate', 'START_GAME');
    expect(hub.command('lobby', 'SET_TEAM_NAME', { team_name: 'Giữa trận' }).code).toBe('INVALID_STATE');
    hub.advance(301_000);
    hub.command('gate', 'CONFIRM_EXIT');
    hub.command('gate', 'RESET_DONE');
    hub.command('room305', 'RESET_DONE');
    hub.command('gate', 'GATE_FINALIZE');
    expect(hub.command('lobby', 'SET_TEAM_NAME', { team_name: 'Muộn' }).code).toBe('INVALID_STATE');
  });

  it('is drafted before the team exists and travels with the reception', () => {
    const hub = new TestHub();
    expect(hub.command('lobby', 'SET_TEAM_NAME', { team_name: 'Chưa có đội' }).code).toBe('INVALID_STATE');
    expect(hub.command('lobby', 'CALL_TEAM', { team_name: 'Phantom 05' }).ok).toBe(true);
    expect(hub.snapshot().active_round?.team_name).toBe('Phantom 05');
    expect(latest(hub, 'CALL_TEAM')?.metadata?.team_name).toBe('Phantom 05');
  });
});
