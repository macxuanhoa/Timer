import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { Dashboard } from './Dashboard';
import { Home } from './Home';
import { Observer } from './Observer';
import { UpdateGate } from './UpdateGate';
import { enterStation, gatewayFor, logout, refreshSession, saveSession, type StoredSession } from './session';
import { USING_SUPABASE, withTimeout } from '../client/gateway';
import { LiveStore } from '../client/liveStore';
import { PwaUpdate } from './PwaUpdate';
import { isClientStale } from '../shared/version';

export default function App() {
  const [checking, setChecking] = useState(true);
  const [verified, setVerified] = useState(false);
  const [session, setSession] = useState<StoredSession | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [liveStore, setLiveStore] = useState<LiveStore | null>(null);
  // V3.3 forced-update: the boot-time probe reads sc.state_revision() and
  // detects "this bundle is stale" before the phone is even allowed to claim a
  // seat. LiveStore.verifyNow also flips the store's own staleClient flag after
  // login, and both paths feed the same UpdateGate screen. A phone that reads
  // the floor as fresh never renders the gate; a phone that once read it as
  // stale stays on the gate until the fresh shell takes over.
  const [bootStale, setBootStale] = useState(false);
  const releasing = useRef(false);
  const generation = useRef(0);
  const sessionRef = useRef(session);
  sessionRef.current = session;

  const acceptSession = useCallback((next: StoredSession) => {
    generation.current++;
    setError(null); setVerified(true); setSession(next);
  }, []);

  // Pre-login probe. public.min_client_version() (migration 0020) answers without
  // a binding, unlike state_revision which is operator-only, so a phone learns it
  // is stale before it claims a seat. Local dev reads the in-process hub instead.
  // The probe never gates the app on success: only a definitive "stale" answer
  // locks the surface, and a failed probe falls through to the normal flow where
  // the store's own verify tick (now timeout-backed) keeps watching.
  useEffect(() => {
    const probe = (floor: unknown) => {
      if (typeof floor === 'string' && isClientStale(floor)) setBootStale(true);
    };
    if (!USING_SUPABASE) {
      withTimeout(
        fetch('/api/revision', { signal: AbortSignal.timeout(6_000) }).then((res) => (res.ok ? res.json() : null)),
        7_000, '/api/revision',
      ).then((body) => probe((body as { min_client_version?: string } | null)?.min_client_version))
        .catch(() => undefined);
      return;
    }
    void import('../client/supabaseAuth').then(({ supabase }) =>
      withTimeout(supabase().rpc('min_client_version'), 7_000, 'min_client_version')
        .then(({ data }) => probe(data))
        .catch(() => undefined),
    ).catch(() => undefined);
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
  if (bootStale) return <UpdateGate />;
  if (!session) return <><Home error={error} canSelect={verified} onEnter={acceptSession} /><PwaUpdate /></>;
  if (!liveStore) return <Splash text={error ?? 'ĐANG KẾT NỐI MÁY CHỦ…'} />;
  return (
    <>
      {session.account.role === 'OBSERVER' ? (
        <Observer store={liveStore} account={session.account} token={session.token} onLogout={release} />
      ) : (
        <Dashboard store={liveStore} account={session.account} onLogout={release} />
      )}
      <PwaUpdate />
      {/* Two sources agree on the gate: the pre-login probe (bootStale) and the
          store's live read of sc.state_revision (liveStore.getSnapshot().staleClient).
          Either one flips to true and the operator's screen is replaced by the
          update gate until the fresh shell takes over. */}
      <StaleGate store={liveStore} bootStale={bootStale} />
    </>
  );
}

/**
 * Renders nothing while the phone is current, and the full-screen UpdateGate
 * once either source (boot probe or live store) says the bundle is stale. Kept
 * in its own component so useSyncExternalStore is only subscribed once a
 * LiveStore exists.
 */
function StaleGate({ store, bootStale }: { store: LiveStore; bootStale: boolean }) {
  const state = useSyncExternalStore(store.subscribe, store.getSnapshot);
  if (!bootStale && !state.staleClient) return null;
  return <UpdateGate />;
}

function Splash({ text }: { text: string }) {
  return <div className="flex h-[100dvh] items-center justify-center bg-ink"><div className="text-center">
    <p className="digital text-[0.9rem] tracking-[0.3em] text-blood">SCREAM CONTROL</p>
    <p className="mt-3 text-[0.75rem] text-mute" data-testid="splash">{text}</p>
  </div></div>;
}
