import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import type { Role } from '../shared/constants';
import type { StationBoard } from '../shared/types';

/**
 * Passwordless operator access.
 *
 * The browser keeps its anonymous session and publishable key. The supervisor
 * PIN is sent once per claim, never saved; privileged keys stay outside this app.
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
  ROLE_TAKEN: 'VỊ TRÍ ĐANG CÓ NGƯỜI TRỰC',
  ALREADY_BOUND_OTHER_ROLE: 'MÁY NÀY ĐANG GIỮ VỊ TRÍ KHÁC — VỀ HOME TRƯỚC KHI CHUYỂN',
  NOT_AUTHENTICATED: 'CHƯA TẠO ĐƯỢC PHIÊN ẨN DANH TRÊN MÁY NÀY',
  PIN_INVALID: 'PIN KHÔNG ĐÚNG',
  PIN_RATE_LIMITED: 'ĐÃ THỬ QUÁ NHIỀU LẦN — CHỜ 15 PHÚT HOẶC LIÊN HỆ QUẢN TRỊ',
  PIN_NOT_CONFIGURED: 'SUPERVISOR CHƯA ĐƯỢC MỞ — LIÊN HỆ QUẢN TRỊ',
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

/** The board reset is checked inside PostgreSQL; these are its refusal reasons. */
const RESET_ERROR: Record<string, string> = {
  NOT_AUTHENTICATED: 'CHƯA TẠO ĐƯỢC PHIÊN ẨN DANH TRÊN MÁY NÀY',
  RESET_INVALID: 'MẬT KHẨU RESET KHÔNG ĐÚNG',
  RESET_RATE_LIMITED: 'ĐÃ THỬ QUÁ NHIỀU LẦN — CHỜ 15 PHÚT HOẶC LIÊN HỆ QUẢN TRỊ',
  RESET_NOT_CONFIGURED: 'RESET CHƯA ĐƯỢC MỞ — LIÊN HỆ QUẢN TRỊ',
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

  const { error: signInError } = await sb.auth.signInAnonymously();
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
  const { data, error } = await supabase().rpc('claim_station', {
    p_role: role,
    p_pin: pin ?? null,
  });
  if (error) throw new Error(error.message);
  return data as ClaimResult;
}

/** The role this device currently holds, or null when it holds none. */
export async function currentProfile(): Promise<OperatorProfile | null> {
  const sb = supabase();
  const { data: sessionData, error: sessionError } = await sb.auth.getSession();
  if (sessionError) throw new Error(sessionError.message);
  if (!sessionData.session) return null;

  const { data, error } = await sb.rpc('whoami');
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
 * Organiser sweep: free every occupied station at once. The secret is sent to
 * PostgreSQL and compared against a bcrypt hash there — the app never knows
 * whether a secret is configured beyond the server's own refusal, and the typed
 * secret is not kept in storage. Event, round and timer data are untouched.
 */
export async function resetAllStations(secret: string): Promise<ResetResult> {
  await ensureAnonymousSession();
  const { data, error } = await supabase().rpc('reset_all_stations', { p_secret: secret });
  if (error) throw new Error(error.message);
  return data as ResetResult;
}

/** Realtime carries no authority; its hints trigger a fresh occupancy RPC. */
export function watchStationBoard(onChange: () => void): () => void {
  const sb = supabase();
  const channel = sb.channel('station-occupancy')
    .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'station_occupancy' }, onChange)
    .subscribe(status => { if (status === 'SUBSCRIBED') onChange(); });
  return () => { void sb.removeChannel(channel); };
}
