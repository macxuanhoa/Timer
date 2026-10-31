import { useEffect, useRef, useState } from 'react';
import type { LiveStore } from '../client/liveStore';

/**
 * Estimated authoritative "now", re-rendered on a cadence that matches the
 * clock being shown: rAF only for the official game countdown.
 */
export function useNow(store: LiveStore, cadence: 'raf' | 'slow' = 'slow'): number {
  const [now, setNow] = useState(() => store.serverNow());

  useEffect(() => {
    let raf = 0;
    let timer = 0;
    if (cadence === 'raf') {
      const loop = () => {
        setNow(store.serverNow());
        raf = requestAnimationFrame(loop);
      };
      raf = requestAnimationFrame(loop);
    } else {
      timer = window.setInterval(() => setNow(store.serverNow()), 250);
      setNow(store.serverNow());
    }
    return () => {
      if (raf) cancelAnimationFrame(raf);
      if (timer) clearInterval(timer);
    };
  }, [store, cadence]);

  return now;
}

/** Keeps the screen awake while an event is live (where the browser allows it). */
export function useWakeLock(active: boolean): void {
  const lock = useRef<WakeLockSentinel | null>(null);
  useEffect(() => {
    const nav = navigator as Navigator & { wakeLock?: WakeLock };
    if (!nav.wakeLock) return;
    let cancelled = false;
    const acquire = async () => {
      try {
        lock.current = await nav.wakeLock!.request('screen');
      } catch {
        lock.current = null;
      }
    };
    const release = () => {
      void lock.current?.release().catch(() => undefined);
      lock.current = null;
    };
    const onVisible = () => {
      if (document.visibilityState === 'visible' && active && !lock.current) void acquire();
    };
    if (active) void acquire();
    else release();
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      cancelled = true;
      document.removeEventListener('visibilitychange', onVisible);
      release();
      void cancelled;
    };
  }, [active]);
}
