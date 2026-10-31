import type { Plugin } from 'vite';
import { createHub } from './hub.ts' ;
import { FileStore } from './store.ts' ;
import { OffsetClock } from '../shared/types.ts' ;

/**
 * Mounts the authoritative local engine into the Vite dev server, so operators
 * can run the full five-phone workflow with zero external credentials.
 * Production uses the Supabase gateway instead (see README).
 */
export function screamLocalServer(options: { dataFile?: string; testClock?: boolean } = {}): Plugin {
  return {
    name: 'scream-control-local-engine',
    configureServer(server) {
      const hub = createHub({
        store: new FileStore(options.dataFile ?? '.scream-data/event.json'),
        // Real time, but stepable so the browser suite can reach the closing
        // warnings without waiting 75 minutes.
        clock: new OffsetClock(),
        allowTestClock: options.testClock ?? true,
      });
      server.middlewares.use((req, res, next) => {
        if ((req.url ?? '').startsWith('/api/')) return hub.handler(req, res);
        next();
      });
      server.httpServer?.on('close', () => {
        /* state is already persisted on every commit */
      });
    },
  };
}
