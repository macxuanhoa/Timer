import { useCallback, useEffect, useRef, useState } from 'react';
import { Dashboard } from './Dashboard';
import { Home } from './Home';
import { enterStation, gatewayFor, logout, refreshSession, saveSession, type StoredSession } from './session';
import { USING_SUPABASE } from '../client/gateway';
import { LiveStore } from '../client/liveStore';
import { PwaUpdate } from './PwaUpdate';

export default function App() {
  const [checking, setChecking] = useState(true);
  const [verified, setVerified] = useState(false);
  const [session, setSession] = useState<StoredSession | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [liveStore, setLiveStore] = useState<LiveStore | null>(null);
  const releasing = useRef(false);
  const generation = useRef(0);
  const sessionRef = useRef(session);
  sessionRef.current = session;

  const acceptSession = useCallback((next: StoredSession) => {
    generation.current++;
    setError(null); setVerified(true); setSession(next);
  }, []);

  useEffect(() => {
    let disposed = false;
    let busy = false;
    const verify = async (boot = false) => {
      if (busy || releasing.current) return;
      busy = true;
      const version = generation.current;
      try {
        const next = boot ? await enterStation() : USING_SUPABASE ? await refreshSession() : sessionRef.current;
        if (disposed || version !== generation.current) return;
        setVerified(true); setError(null);
        setSession(current => current?.account.id === next?.account.id && current?.account.role === next?.account.role ? current : next);
      } catch {
        if (!disposed && version === generation.current) {
          setVerified(false);
          setError('CHƯA XÁC MINH ĐƯỢC PHIÊN — ĐANG KẾT NỐI LẠI…');
        }
      } finally { busy = false; if (!disposed) setChecking(false); }
    };
    void verify(true);
    const timer = window.setInterval(() => void verify(), 5_000);
    const onVisible = () => { if (document.visibilityState === 'visible') void verify(); };
    window.addEventListener('online', onVisible);
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      disposed = true; window.clearInterval(timer);
      window.removeEventListener('online', onVisible); document.removeEventListener('visibilitychange', onVisible);
    };
  }, []);

  useEffect(() => {
    let disposed = false;
    let created: LiveStore | null = null;
    setLiveStore(null);
    if (!session) return;
    void (async () => {
      try {
        const gateway = await gatewayFor(session);
        if (disposed) return;
        created = new LiveStore({ gateway, account: session.account });
        await created.start();
        if (disposed) { created.stop(); return; }
        setLiveStore(created);
      } catch {
        if (!disposed) {
          setError('CHƯA KẾT NỐI ĐƯỢC VỊ TRÍ — ĐANG KẾT NỐI LẠI…');
          // Recheck authority before allowing another selection.
          setVerified(false); setSession(null);
        }
      }
    })();
    return () => { disposed = true; created?.stop(); };
  }, [session]);

  const release = async () => {
    if (releasing.current) return;
    releasing.current = true;
    generation.current++;
    try {
      await logout();
      liveStore?.stop(); setLiveStore(null); setSession(null); setError(null); setVerified(true);
      saveSession(null);
    } finally { releasing.current = false; }
  };

  if (checking) return <Splash text="ĐANG KIỂM TRA PHIÊN…" />;
  if (!session) return <><Home error={error} canSelect={verified} onEnter={acceptSession} /><PwaUpdate /></>;
  if (!liveStore) return <Splash text={error ?? 'ĐANG KẾT NỐI MÁY CHỦ…'} />;
  return <><Dashboard store={liveStore} account={session.account} onLogout={release} /><PwaUpdate /></>;
}

function Splash({ text }: { text: string }) {
  return <div className="flex h-[100dvh] items-center justify-center bg-ink"><div className="text-center">
    <p className="digital text-[0.9rem] tracking-[0.3em] text-blood">SCREAM CONTROL</p>
    <p className="mt-3 text-[0.75rem] text-mute" data-testid="splash">{text}</p>
  </div></div>;
}
