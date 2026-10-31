import { useEffect, useRef, useState } from 'react';
import { Dashboard } from './Dashboard';
import { Invitation } from './Invitation';
import { enterStation, gatewayFor, logout, type StoredSession } from './session';
import { LiveStore } from '../client/liveStore';
import { PwaUpdate } from './PwaUpdate';

export default function App() {
  const booted = useRef(false);
  const [checking, setChecking] = useState(true);
  const [session, setSession] = useState<StoredSession | null>(null);
  const [gateError, setGateError] = useState<string | null>(null);
  const [liveStore, setLiveStore] = useState<LiveStore | null>(null);

  /** One boot path: invitation link, restored session, or the invitation gate. */
  const boot = async () => {
    setChecking(true);
    setGateError(null);
    try {
      setSession(await enterStation());
    } catch (err) {
      setSession(null);
      setGateError(err instanceof Error ? err.message : 'KHÔNG MỞ ĐƯỢC PHIÊN TRỰC');
    } finally {
      setChecking(false);
    }
  };

  // StrictMode mounts effects twice; the anonymous sign-in must happen once.
  useEffect(() => {
    if (booted.current) return;
    booted.current = true;
    void boot();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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
    void (async () => {
      try {
        // Releasing the station on the server comes first: if it fails (offline)
        // the phone keeps its role instead of being stranded without one.
        await logout();
        setLiveStore(null);
        setSession(null);
        setGateError(null);
      } catch {
        /* keep the live station and let the operator try again */
      }
    })();
  };

  if (checking) return <Splash text="ĐANG KIỂM TRA PHIÊN…" />;
  if (!session) {
    return (
      <Invitation
        error={gateError}
        onEnter={(next) => {
          setGateError(null);
          setSession(next);
        }}
        onRetryBoot={() => void boot()}
      />
    );
  }
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
