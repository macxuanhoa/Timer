import { useEffect, useState } from 'react';
import { Dashboard } from './Dashboard';
import { Login } from './Login';
import { gatewayFor, loadSession, logout as clearSession, type StoredSession } from './session';
import { LiveStore } from '../client/liveStore';
import { USING_SUPABASE } from '../client/gateway';
import { PwaUpdate } from './PwaUpdate';

export default function App() {
  const [session, setSession] = useState<StoredSession | null>(() => loadSession());
  const [checking, setChecking] = useState(USING_SUPABASE);

  // Supabase restores its own persisted auth session on cold start.
  useEffect(() => {
    if (!USING_SUPABASE) return;
    void (async () => {
      const { supabaseCurrentSession } = await import('../client/supabaseAuth');
      setSession(await supabaseCurrentSession());
      setChecking(false);
    })();
  }, []);

  const [liveStore, setLiveStore] = useState<LiveStore | null>(null);

  // One store per signed-in operator: calibrate clock, load snapshot, subscribe.
  useEffect(() => {
    let disposed = false;
    let created: LiveStore | null = null;
    setLiveStore(null);
    if (!session) return;
    void (async () => {
      const gateway = await gatewayFor(session);
      if (disposed) return;
      created = new LiveStore({ gateway, account: session.account });
      await created.start();
      if (disposed) {
        created.stop();
        return;
      }
      setLiveStore(created);
    })();
    return () => {
      disposed = true;
      created?.stop();
    };
  }, [session]);

  const signOut = () => {
    void clearSession();
    setLiveStore(null);
    setSession(null);
  };

  if (checking) return <Splash text="ĐANG KIỂM TRA PHIÊN…" />;
  if (!session) return <Login onSignedIn={(s) => setSession(s)} />;
  if (!liveStore) return <Splash text="ĐANG KẾT NỐI MÁY CHỦ…" />;

  return (
    <>
      <Dashboard store={liveStore} account={session.account} onLogout={signOut} />
      <PwaUpdate />
    </>
  );
}

function Splash({ text }: { text: string }) {
  return (
    <div className="flex h-[100dvh] items-center justify-center bg-ink">
      <div className="text-center">
        <p className="digital text-[0.9rem] tracking-[0.3em] text-blood">SCREAM CONTROL</p>
        <p className="mt-3 text-[0.75rem] text-mute" data-testid="splash">{text}</p>
      </div>
    </div>
  );
}
