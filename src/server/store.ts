import { readFileSync, writeFileSync, mkdirSync, renameSync } from 'node:fs';
import { dirname } from 'node:path';
import type { PersistedState } from './engine.ts' ;

/** Storage seam so the same engine can run on a file (dev), memory (tests) or Postgres (prod). */
export interface StateStore {
  load(): PersistedState | null;
  save(state: PersistedState): void;
}

export class MemoryStore implements StateStore {
  private state: PersistedState | null = null;
  load(): PersistedState | null {
    return this.state ? (structuredClone(this.state) as PersistedState) : null;
  }
  save(state: PersistedState): void {
    this.state = structuredClone(state) as PersistedState;
  }
}

/**
 * Atomic JSON file store. A dev-server restart therefore restores the currently
 * running event and round instead of losing the session.
 */
export class FileStore implements StateStore {
  constructor(private readonly file: string) {}

  load(): PersistedState | null {
    try {
      return JSON.parse(readFileSync(this.file, 'utf8')) as PersistedState;
    } catch {
      return null;
    }
  }

  save(state: PersistedState): void {
    mkdirSync(dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify(state), 'utf8');
    renameSync(tmp, this.file);
  }
}
