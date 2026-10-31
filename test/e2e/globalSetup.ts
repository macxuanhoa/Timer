import { rmSync } from 'node:fs';

/** Each run must start from a clean event, not the previous run's persisted one. */
export default function globalSetup() {
  rmSync('.scream-data', { recursive: true, force: true });
}
