import { useEffect, useState } from 'react';

/**
 * V3.3 forced-update gate. This screen replaces the whole app body once the
 * server has said "your bundle is stale". There is no dismiss and no "later":
 * the only way back into an operating surface is a fresh shell. A reload is
 * offered as a hard refresh (bypass HTTP cache) so a phone that has already
 * received the new bundle via service worker swap can adopt it in one tap.
 *
 * The gate is deliberately independent from LiveStore — the operator's session
 * stays bound while the phone is stuck on this screen, so a supervisor who
 * reopens the app after reload lands on their own admin seat without needing
 * to reclaim. Only `handle_command` is refused server-side; `release_station`
 * stays reachable precisely so the stuck-seat escape hatch does not require a
 * fresh bundle.
 */
export function UpdateGate({ appName = 'SCREAM CONTROL' }: { appName?: string }) {
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    const t = window.setInterval(() => setElapsed((v) => v + 1), 1000);
    return () => window.clearInterval(t);
  }, []);

  const hardRefresh = () => {
    // Skip the service worker: unregister and reload with cache-busting so an
    // operator holding a phone that still references an old shell gets the
    // fresh bundle in one tap, whatever the browser's own update loop looks
    // like. navigator.serviceWorker.unregister is safe on a phone with no SW.
    void navigator.serviceWorker?.getRegistrations?.().then((regs) => {
      void Promise.all((regs ?? []).map((r) => r.unregister()));
    }).catch(() => undefined);
    const sep = window.location.search ? '&' : '?';
    window.location.replace(`${window.location.pathname}${sep}r=${Date.now()}${window.location.hash}`);
  };

  return (
    <div
      className="fixed inset-0 z-[80] flex flex-col items-center justify-center gap-4 bg-ink px-6 text-center"
      role="alertdialog"
      aria-live="assertive"
      data-testid="update-gate"
    >
      <div className="update-gate-scan" aria-hidden />
      <p className="digital text-[0.72rem] tracking-[0.32em] text-blood">
        {appName}
      </p>
      <h1 className="text-[1.75rem] font-black leading-tight tracking-[-0.02em] text-snow">
        ỨNG DỤNG CẦN<br />CẬP NHẬT
      </h1>
      <p className="max-w-[16rem] text-[0.78rem] leading-snug text-mute">
        Cập nhật để tiếp tục thao tác.
      </p>
      <button
        type="button"
        onClick={hardRefresh}
        data-testid="update-gate-reload"
        className="mt-1 w-full max-w-[16rem] rounded-panel border border-ember bg-ember/10 px-4 py-3.5 text-[0.9rem] font-bold tracking-[0.06em] text-ember active:bg-ember/20"
      >
        CẬP NHẬT NGAY
      </button>
      <p className="text-[0.66rem] leading-snug text-mute" data-testid="update-gate-hint">
        {elapsed < 15
          ? 'Nếu màn hình chưa đổi sau vài giây, tắt hẳn ứng dụng rồi mở lại.'
          : 'Vẫn chưa xong? Mở Cài đặt ứng dụng → xoá bộ nhớ đệm, rồi mở lại link.'}
      </p>
    </div>
  );
}
