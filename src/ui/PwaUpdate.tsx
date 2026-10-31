import { useState } from 'react';
import { useRegisterSW } from 'virtual:pwa-register/react';

/**
 * Update behaviour: never reload in the middle of an event. The operator is
 * asked, and the new shell activates on the next cold start if they decline.
 */
export function PwaUpdate() {
  const [dismissed, setDismissed] = useState(false);
  const {
    needRefresh: [needRefresh],
    updateServiceWorker,
  } = useRegisterSW({
    onRegisteredSW(_swUrl, r) {
      if (!r) return;
      // Check for a new build hourly — never auto-apply while operators are live.
      setInterval(() => void r.update(), 60 * 60 * 1000);
    },
  });

  if (!needRefresh || dismissed) return null;
  return (
    <div className="fixed inset-x-3 bottom-24 z-50 rounded-panel border border-ember/50 bg-panel px-4 py-3 shadow-xl shadow-black/50" role="alertdialog" data-testid="pwa-update">
      <p className="text-[0.75rem] text-ember">Có phiên bản ứng dụng mới.</p>
      <div className="mt-2 flex gap-2">
        <button type="button" onClick={() => void updateServiceWorker(true)} className="flex-1 rounded bg-ember px-3 py-2 text-[0.72rem] font-bold text-[#1a1204]" data-testid="pwa-update-apply">
          CẬP NHẬT NGAY
        </button>
        <button type="button" onClick={() => setDismissed(true)} className="flex-1 rounded border border-hair px-3 py-2 text-[0.72rem] text-mute" data-testid="pwa-update-dismiss">
          ĐỂ SAU
        </button>
      </div>
    </div>
  );
}
