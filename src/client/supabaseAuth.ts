import { createClient } from '@supabase/supabase-js';
import type { StoredSession } from '../ui/session';
import type { Role } from '../shared/constants';

const emailFor = (account: string): string => `${account}@${import.meta.env.VITE_OPERATOR_DOMAIN ?? 'scream305.local'}`;

const client = () =>
  createClient(import.meta.env.VITE_SUPABASE_URL as string, import.meta.env.VITE_SUPABASE_ANON_KEY as string);

export async function supabaseLogin(accountId: string, passcode: string): Promise<StoredSession> {
  const sb = client();
  const { data, error } = await sb.auth.signInWithPassword({ email: emailFor(accountId), password: passcode });
  if (error) throw new Error(error.message);
  const userId = data.user.id;
  const { data: profile, error: profileError } = await sb.from('operators').select('role,display_name').eq('user_id', userId).single();
  if (profileError || !profile) throw new Error('TÀI KHOẢN CHƯA ĐƯỢC PHÂN QUYỀN VỊ TRÍ');
  return {
    token: data.session.access_token,
    account: { id: userId, role: profile.role as Role, display_name: profile.display_name as string },
  };
}

export async function supabaseCurrentSession(): Promise<StoredSession | null> {
  const sb = client();
  const { data } = await sb.auth.getSession();
  const user = data.session?.user;
  if (!user) return null;
  const { data: profile } = await sb.from('operators').select('role,display_name').eq('user_id', user.id).single();
  if (!profile) return null;
  return {
    token: data.session!.access_token,
    account: { id: user.id, role: profile.role as Role, display_name: profile.display_name as string },
  };
}

export async function supabaseLogout(): Promise<void> {
  await client().auth.signOut();
}
