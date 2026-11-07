import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import type { Role } from '../shared/constants';
import type { StationBoard } from '../shared/types';
import { GATEWAY_TIMEOUT_MS, withTimeout } from './gateway';

/**
 * Duty and viewing positions are password-free; Home's admin circle needs a PIN.
 * PostgreSQL enforces capacity, validates the PIN and binds the authenticated
 * identity. Leaving revokes that binding and its permissions.
 */

const URL_KEY = import.meta.env.VITE_SUPABASE_URL as string | undefined;
const ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined;

let singleton: SupabaseClient | null = null;

/** One client for the whole app: two GoTrue instances would race on refresh. */
export function supabase(): SupabaseClient {
  if (!URL_KEY || !ANON_KEY) throw new Error('THIẾU VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY');
  singleton ??= createClient(URL_KEY, ANON_KEY, {
    auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false },
  });
  return singleton;
}

export interface OperatorProfile {
  role: Role;
  display_name: string;
}

export interface ClaimResult {
  ok: boolean;
  code: string;
  message?: string;
  role?: Role;
  display_name?: string;
  event_id?: number;
}

/** What the person holding the phone needs to read, not the RPC code. */
const CLAIM_ERROR: Record<string, string> = {
  PIN_REQUIRED: 'Cần nhập mật mã quản trị.',
  PIN_INVALID: 'Mật mã chưa đúng.',
  PIN_RATE_LIMITED: 'Đã thử nhiều lần. Chờ 15 phút rồi thử lại.',
  PIN_NOT_CONFIGURED: 'Quản trị chưa được cấu hình trên máy chủ.',
  ROLE_TAKEN: 'Vị trí đã có người trực.',
  OBSERVER_FULL: 'ĐÃ ĐỦ 10 NGƯỜI THEO DÕI — VUI LÒNG THỬ LẠI SAU',
  ALREADY_BOUND_OTHER_ROLE: 'MÁY NÀY ĐANG GIỮ VỊ TRÍ KHÁC — VỀ HOME TRƯỚC KHI CHUYỂN',
  NOT_AUTHENTICATED: 'CHƯA TẠO ĐƯỢC PHIÊN ẨN DANH TRÊN MÁY NÀY',
  // Compatibility with a server that has not yet applied the PIN migration.
  ADMIN_NOT_ALLOWED: 'Chưa cấp được quyền quản trị. Kiểm tra cấu hình máy chủ.',
  INVALID_ROLE: 'VỊ TRÍ KHÔNG HỢP LỆ',
};

export function claimErrorMessage(result: ClaimResult | null): string {
  return CLAIM_ERROR[result?.code ?? ''] ?? 'CHƯA VÀO ĐƯỢC VỊ TRÍ — KIỂM TRA KẾT NỐI';
}

export interface ResetResult {
  ok: boolean;
  code: string;
  /** How many duty bindings the server actually revoked. */
  freed?: number;
}

/** The board release is checked inside PostgreSQL; these are its refusal reasons. */
const RESET_ERROR: Record<string, string> = {
  NOT_AUTHENTICATED: 'CHƯA TẠO ĐƯỢC PHIÊN ẨN DANH TRÊN MÁY NÀY',
  // V3.2: only a device currently holding the admin seat may sweep the board.
  RESET_NOT_AUTHORIZED: 'CHỈ MÁY ĐANG GIỮ GHẾ QUẢN TRỊ MỚI ĐƯỢC GIẢI PHÓNG TOÀN BỘ BẢNG',
  RESET_GAME_RUNNING: 'VẪN CÒN ĐỘI TRONG KHU VỰC — NPC 1 CẦN XÁC NHẬN ĐÃ RỜI TẦNG 3 TRƯỚC',
  RESET_PENDING_CLAIM: 'CÒN LẦN BÁO HOÀN THÀNH CHỜ NPC 2 XÁC MINH — KHÔNG GIẢI PHÓNG BẢNG LÚC NÀY',
  RESET_AREA_OPEN: 'KHU VỰC CHƯA XÁC NHẬN RESET XONG — KHÔNG GIẢI PHÓNG BẢNG LÚC NÀY',
};

export function resetErrorMessage(result: ResetResult | null): string {
  return RESET_ERROR[result?.code ?? ''] ?? 'CHƯA RESET ĐƯỢC — KIỂM TRA KẾT NỐI';
}

/**
 * Which of the five stations are already on duty. Readable before sign-in on
 * purpose: the gate has to show the board to a phone that holds no session yet.
 * It names stations only — never people, devices or invitations — and a failure
 * to read it must never block the gate, so it degrades to null.
 */
export async function stationBoard(): Promise<StationBoard | null> {
  try {
    const { data, error } = await supabase().rpc('station_board').abortSignal(AbortSignal.timeout(8_000));
    if (error || !data) return null;
    return data as StationBoard;
  } catch {
    return null;
  }
}

/** Anonymous sign-in happens once per device and is invisible to the operator. */
export async function ensureAnonymousSession(): Promise<void> {
  const sb = supabase();
  const { data, error } = await sb.auth.getSession();
  if (error) throw new Error(error.message);
  if (data.session) return;

  const { error: signInError } = await withTimeout(
    sb.auth.signInAnonymously(), GATEWAY_TIMEOUT_MS, 'signInAnonymously',
  ).catch((err: unknown) => {
    // A stalled or refused network round trip must surface as the plain failure
    // the caller already knows how to report ("CHƯA TẠO ĐƯỢC PHIÊN…"), never as
    // an unhandled rejection, and never as a promise that never settles.
    throw err instanceof Error ? err : new Error(String(err));
  });
  if (!signInError) return;
  const raw = signInError.message ?? '';
  if (/anonymous/i.test(raw)) {
    throw new Error(
      'SUPABASE CHƯA BẬT ĐĂNG NHẬP ẨN DANH — Authentication → Sign In / Providers → Anonymous sign-ins',
    );
  }
  throw new Error(raw || 'KHÔNG TẠO ĐƯỢC PHIÊN ẨN DANH');
}

/** The server derives identity from auth.uid(), never a caller-supplied device. */
export async function claimStation(role: Role, pin?: string): Promise<ClaimResult> {
  await ensureAnonymousSession();
  const { data, error } = await withTimeout(
    supabase().rpc('claim_station', { p_role: role, ...(role === 'SUPERVISOR' ? { p_pin: pin ?? '' } : {}) }), GATEWAY_TIMEOUT_MS, 'claim_station',
  );
  if (error) throw new Error(error.message);
  return data as ClaimResult;
}

/**
 * The anonymous uuid of this device, for the /admin bootstrap screen: the organiser
 * reads it out and inserts it into sc.admin_devices once, from the Supabase SQL
 * editor. Players never see this screen, and nothing here is a secret to type.
 */
export async function myDeviceId(): Promise<string | null> {
  await ensureAnonymousSession();
  const { data } = await supabase().auth.getSession();
  return data.session?.user.id ?? null;
}

/** The role this device currently holds, or null when it holds none. */
export async function currentProfile(): Promise<OperatorProfile | null> {
  const sb = supabase();
  const { data: sessionData, error: sessionError } = await sb.auth.getSession();
  if (sessionError) throw new Error(sessionError.message);
  if (!sessionData.session) return null;

  const { data, error } = await withTimeout(sb.rpc('whoami'), GATEWAY_TIMEOUT_MS, 'whoami');
  if (error) throw new Error(error.message);
  const row = data as { user_id?: string; role?: Role; display_name?: string } | null;
  // The server resolves the binding from auth.uid(); refuse to use a profile
  // that does not belong to the session user, even if a proxy returned one.
  if (!row?.role || row.user_id !== sessionData.session.user.id) return null;
  return { role: row.role, display_name: row.display_name || row.role };
}

/**
 * Release only the caller's station. Keep anonymous auth for the next selection.
 */
export async function leaveStation(): Promise<void> {
  const sb = supabase();
  const { data, error } = await sb.rpc('release_device');
  if (error) throw new Error(error.message);
  if (!(data as { ok?: boolean } | null)?.ok) throw new Error('CHƯA NHẢ ĐƯỢC VỊ TRÍ');
}

/**
 * Organiser sweep: free every occupied station at once, V3.2.
 *
 * There is no secret any more: PostgreSQL authorises the call by the caller's own
 * binding — only a device currently holding the SUPERVISOR seat may sweep. The
 * release is an access action and never stops a clock, closes a round or marks a
 * physical reset. `force` is the emergency path: it aborts any still-open round
 * (recording a safety cancellation) before freeing the seats, so the board can be
 * reclaimed mid-event without leaving a live round nobody can close. Refused while
 * a floor is unfinished unless force is set (V3.2 §2).
 */
export async function resetAllStations(force = false): Promise<ResetResult> {
  await ensureAnonymousSession();
  const { data, error } = await supabase().rpc('reset_all_stations', { p_force: force });
  if (error) throw new Error(error.message);
  return data as ResetResult;
}

/**
 * V3.3 per-seat release: free one named duty binding without touching the rest
 * of the board. Migration 0019 attaches the RPC; the caller must hold a live
 * SUPERVISOR binding inside PostgreSQL (the same authorisation model as
 * resetAllStations). This is the escape hatch for the NPC1-stuck case —
 * a duty phone walked off with the seat still bound, the whole-board sweep is
 * refused because sc._floor_block_reason() still reads the machine as live,
 * and there is no other path to give the seat back.
 *
 * The release never touches a clock, a round, a claim or a checklist; it is a
 * pure access action. Every call lands a sc.access_audit row naming the freed
 * identity and the caller. SUPERVISOR and OBSERVER targets are refused: a
 * supervisor releases their own seat through the normal "Về Home" flow, and a
 * stale viewer is swept by the heartbeat.
 */
export interface ReleaseStationResult {
  ok: boolean;
  code: string;
  target?: string;
  freed?: number;
}

export async function releaseStation(role: Role): Promise<ReleaseStationResult> {
  await ensureAnonymousSession();
  // Bounded like every other call: a socket that never answers must not leave
  // this button spinning forever.
  const { data, error } = await withTimeout(
    supabase().rpc('release_station', { p_role: role }),
    GATEWAY_TIMEOUT_MS,
    'release_station',
  );
  if (error) throw new Error(error.message);
  return data as ReleaseStationResult;
}

/**
 * V3.3 seat management: who holds which duty seat, and whether a seat may be
 * freed right now. Migration 0021 attaches the RPC; PostgreSQL only answers for
 * a caller holding a live SUPERVISOR binding, because the report names other
 * people's devices. `releasable` is the same predicate release_station enforces,
 * so the panel can never offer a tap that the database will refuse.
 */
export interface SeatHolder {
  user_id: string;
  seat_slot: number;
  display_name: string | null;
  bound_at_ms: number;
  held_ms: number;
  last_action: string | null;
  last_action_ms: number | null;
}

export interface SeatReport {
  role: Role;
  capacity: number;
  devices: number;
  holders: SeatHolder[];
  releasable: boolean;
}

export interface StationAdminResult {
  ok: boolean;
  code: string;
  revision?: number;
  server_time_ms?: number;
  floor_block_reason?: string | null;
  stations?: SeatReport[];
}

export async function stationAdmin(): Promise<StationAdminResult> {
  await ensureAnonymousSession();
  const { data, error } = await withTimeout(
    supabase().rpc('station_admin'),
    GATEWAY_TIMEOUT_MS,
    'station_admin',
  );
  if (error) throw new Error(error.message);
  return (data ?? { ok: false, code: 'EMPTY' }) as StationAdminResult;
}

/** The Vietnamese readout of a release_station refusal. */
const RELEASE_ERROR: Record<string, string> = {
  NOT_AUTHENTICATED: 'CHƯA TẠO ĐƯỢC PHIÊN ẨN DANH TRÊN MÁY NÀY',
  RELEASE_NOT_AUTHORIZED: 'CHỈ MÁY ĐANG GIỮ GHẾ QUẢN TRỊ MỚI GIẢI PHÓNG ĐƯỢC VỊ TRÍ',
  INVALID_ROLE: 'VỊ TRÍ KHÔNG HỢP LỆ',
  RELEASE_SELF_TARGET: 'GHẾ QUẢN TRỊ KHÔNG GIẢI PHÓNG BẰNG CÁCH NÀY — DÙNG NÚT "VỀ HOME"',
  RELEASE_NOT_BOUND: 'VỊ TRÍ ĐÓ ĐANG TRỐNG — KHÔNG CÓ GÌ ĐỂ GIẢI PHÓNG',
  // V3.3: the release was refused because the floor is committed, not because
  // anything failed. Saying so is the difference between a tool and a dead end.
  FLOOR_BUSY: 'ĐANG CÓ ĐỘI TRONG KHU VỰC — KHÔNG GIẢI PHÓNG ĐƯỢC. CHỐT LƯỢT RỒI BẤM LẠI',
};

export function releaseErrorMessage(result: ReleaseStationResult | null): string {
  return RELEASE_ERROR[result?.code ?? ''] ?? 'CHƯA GIẢI PHÓNG ĐƯỢC — KIỂM TRA KẾT NỐI';
}

/** Realtime carries no authority; its hints trigger a fresh occupancy RPC. */
export function watchStationBoard(onChange: () => void): () => void {
  const sb = supabase();
  const channel = sb.channel('station-occupancy')
    .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'station_occupancy' }, onChange)
    .subscribe(status => { if (status === 'SUBSCRIBED') onChange(); });
  return () => { void sb.removeChannel(channel); };
}
