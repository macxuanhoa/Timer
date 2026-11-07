/**
 * V3.3 — client build stamp for the forced-update gate.
 *
 * Every command carries this stamp inside `p_meta._v`. The authoritative layer
 * (PostgreSQL `sc.handle_command` in production, and the same check in the
 * in-process engine used by dev/tests) compares it against
 * `sc.runtime_flags.min_client_version` before doing anything else. A phone
 * running an older bundle is refused with `VERSION_STALE`, and the client
 * surface locks onto an "update required" screen until the fresh shell lands.
 *
 * The stamp itself is `APP_VERSION + build epoch`. Two deployments on the same
 * day still differ, so a stale PWA cannot accidentally pass a same-day check.
 * Vite replaces `import.meta.env.VITE_BUILD_STAMP` at build time; the fallback
 * keeps the value stable in vitest (where the define hook is not applied) so
 * unit tests do not see the gate flap between assertions.
 */

/**
 * 3.4.0 is the NPC2 verification & round-completion release: the claim CTA is
 * now derived from the authoritative permission table (a finalised round can no
 * longer offer a press the server would refuse), the official result wears its
 * own milestone presentation, and the synchronisation chip states five separate
 * honest states instead of blurring "connected" and "syncing" into one label.
 * 3.3.1 remains the floor that first carried QUẢN LÝ VỊ TRÍ; raising the
 * server's minimum is an explicit organiser action, never a side effect here.
 */
export const APP_VERSION = '3.4.0';

/**
 * The version that first carries the OPEN_NEW_EVENT and per-seat release flow.
 * The server refuses anything stamped earlier than this once the V3.3 gate is
 * switched on. Kept as a separate constant so the ceiling can move forward
 * without touching the client's own stamp.
 */
export const MIN_CLIENT_VERSION = APP_VERSION;

/** The value the client stamps into every command's `p_meta._v`. */
export const CLIENT_BUILD =
  (import.meta.env.VITE_BUILD_STAMP as string | undefined) ?? `${APP_VERSION}+dev`;

/** Compares two dotted `MAJOR.MINOR.PATCH` strings; returns -1, 0 or 1. */
export function compareSemver(a: string, b: string): -1 | 0 | 1 {
  const pa = a.split('.').map((x) => Number.parseInt(x, 10) || 0);
  const pb = b.split('.').map((x) => Number.parseInt(x, 10) || 0);
  for (let i = 0; i < 3; i++) {
    const x = pa[i] ?? 0;
    const y = pb[i] ?? 0;
    if (x < y) return -1;
    if (x > y) return 1;
  }
  return 0;
}

/**
 * The pure decision the client uses on every authoritative read: if the server
 * says the minimum allowed build is greater than this bundle, the operator's
 * phone is stale and must not send another command. The comparison is on the
 * leading semver portion of `CLIENT_BUILD` (everything after `+` is metadata).
 */
export function isClientStale(minClientVersion: string | null | undefined): boolean {
  if (!minClientVersion) return false;
  const self = APP_VERSION;
  return compareSemver(self, minClientVersion) < 0;
}
