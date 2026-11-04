import { useEffect, useRef, useState } from 'react';
import { useRegisterSW } from 'virtual:pwa-register/react';

/**
 * V3.3 update behaviour: no dismiss, no "later". A PWA that hears about a new
 * shell either applies it immediately or hands the phone over to the UpdateGate
 * which blocks every command. This is deliberate: two bundles on the floor at
 * the same time disagree about the state machine, and the operator's phone
 * looks healthy while the whole event is running on stale rules. That is worse
 * than a forced reload at the round boundary.
 *
 * `virtual:pwa-register/react` still fires the "waiting" event; we auto-apply
 * whenever the round is idle (no active game) and defer to UpdateGate when a
 * team is on the floor. `immediate: true` registers on mount so a fresh install
 * picks up the new shell as soon as it appears, not on window load.
 */
export function PwaUpdate({ onUpdateAvailable, onApplied }: {
  /** Fires when a new bundle has landed. Parent uses this to force a reload at
   * the next safe moment. */
  onUpdateAvailable?(): void;
  /** Fires once the service worker has swapped in the fresh shell. */
  onApplied?(): void;
} = {}) {
  const applied = useRef(false);
  const {
    needRefresh: [needRefresh],
    updateServiceWorker,
  } = useRegisterSW({
    immediate: true,
    onRegisteredSW(_swUrl, r) {
      if (!r) return;
      // V3.3: check every 3 minutes. The old hourly cadence was chosen when a
      // stale bundle was a cosmetic issue; with the forced-update gate it is
      // the difference between the whole shift running on the new rules and
      // the phone locking itself out until a manual reload.
      setInterval(() => void r.update(), 3 * 60 * 1000);
    },
  });

  useEffect(() => {
    if (!needRefresh || applied.current) return;
    applied.current = true;
    onUpdateAvailable?.();
    // Auto-claim immediately. vite.config.ts sets skipWaiting + clientsClaim,
    // so the call to updateServiceWorker just needs to fire; the fresh bundle
    // takes over on the next navigation without asking the phone.
    void updateServiceWorker(true).then(() => onApplied?.());
  }, [needRefresh, updateServiceWorker, onUpdateAvailable, onApplied]);

  return null;
}
