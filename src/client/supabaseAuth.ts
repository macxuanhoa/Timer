import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import type { Role } from '../shared/constants';
import type { StationBoard } from '../shared/types';

/**
 * Passwordless operator access.
 *
 * The phone signs in anonymously (Supabase Anonymous Sign-ins) and an invitation
 * link exchanges that anonymous identity for one operator role. Nothing here
 * handles an email, a password, a service key or a secret key: the browser only
 * ever holds the publishable key and the station token it was given.
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

export interface RedeemResult {
  ok: boolean;
  code: string;
  message?: string;
  role?: Role;
  display_name?: string;
  event_id?: number;
}

/** What the person holding the phone needs to read, not the RPC code. */
// Links are permanent (0007): the seat is what can be busy, so the wording tells
// the operator to wait for the phone on duty or to use ĐỔI MÁY — never to ask
// for a new link.
const INVITE_ERROR: Record<string, string> = {
  INVITATION_INVALID: 'LIÊN KẾT KHÔNG HỢP LỆ HOẶC ĐÃ BỊ THU HỒI — LIÊN HỆ BAN TỔ CHỨC',
  ROLE_TAKEN: 'VỊ TRÍ ĐANG CÓ NGƯỜI SỬ DỤNG',
  STATIONS_LOCKED: 'ĐÃ ĐỦ 5 VỊ TRÍ — KHÔNG CÒN VỊ TRÍ TRỐNG',
  ALREADY_BOUND_OTHER_ROLE: 'MÁY NÀY ĐANG TRỰC MỘT VỊ TRÍ KHÁC — DÙNG ĐÚNG LINK CỦA VỊ TRÍ ĐÓ',
  NOT_AUTHENTICATED: 'CHƯA TẠO ĐƯỢC PHIÊN ẨN DANH TRÊN MÁY NÀY',
};

export function inviteErrorMessage(result: RedeemResult | null): string {
  if (!result) return 'KHÔNG MỞ ĐƯỢC LIÊN KẾT';
  return INVITE_ERROR[result.code] ?? result.message ?? 'KHÔNG MỞ ĐƯỢC LIÊN KẾT';
}

/**
 * Which of the five stations are already on duty. Readable before sign-in on
 * purpose: the gate has to show the board to a phone that holds no session yet.
 * It names stations only — never people, devices or invitations — and a failure
 * to read it must never block the gate, so it degrades to null.
 */
export async function stationBoard(): Promise<StationBoard | null> {
  try {
    const { data, error } = await supabase().rpc('station_board');
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

/** Exchanges one invitation token for a device-bound binding. */
export async function redeemInvitation(token: string, deviceId: string): Promise<RedeemResult> {
  await ensureAnonymousSession();
  const { data, error } = await supabase().rpc('redeem_invitation', {
    p_token: token,
    p_device_id: deviceId,
  });
  if (error) throw new Error(error.message);
  return data as RedeemResult;
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
 * Gives the station up and forgets the anonymous identity, so the replacement
 * phone can open the same link with a fresh one. Both steps are required: a
 * release without sign-out would let this phone claim the role again.
 */
export async function leaveStation(): Promise<void> {
  const sb = supabase();
  const { error } = await sb.rpc('release_device');
  if (error) throw new Error(error.message);
  await sb.auth.signOut();
}
