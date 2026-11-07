import type { ReactNode } from 'react';

/** Optional guidance remains reachable by touch and keyboard. */
export function HelpDetails({ children, label = 'Hướng dẫn' }: { children: ReactNode; label?: string }) {
  return <details className="help-details"><summary>{label}</summary><div className="help-details-body">{children}</div></details>;
}
