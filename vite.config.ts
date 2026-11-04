import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { VitePWA } from 'vite-plugin-pwa';
import { screamLocalServer } from './src/server/vitePlugin.ts';

const useSupabase = process.env.VITE_BACKEND === 'supabase';

// V3.3 build stamp. Injected into the client bundle so the forced-update gate
// (see src/shared/version.ts) can compare this bundle against the server's
// min_client_version, and so two deployments on the same day always carry a
// distinct identity. Date.now() is captured at build time by Vercel's CI, so it
// is stable across the whole bundle the phone will download.
const BUILD_STAMP = process.env.VITE_BUILD_STAMP
  ?? `${new Date().toISOString().replace(/[:\-]/g, '').slice(0, 15)}`;

export default defineConfig({
  define: {
    'import.meta.env.VITE_BUILD_STAMP': JSON.stringify(BUILD_STAMP),
  },
  plugins: [
    tailwindcss(),
    react(),
    // The authoritative engine runs in-process during development so the full
    // five-operator workflow is testable with zero external credentials.
    ...(useSupabase ? [] : [screamLocalServer({ dataFile: '.scream-data/event.json' })]),
    VitePWA({
      // V3.3: autoUpdate replaces the old "prompt" flow. Together with
      // skipWaiting + clientsClaim below, a phone that has the app open when
      // a fresh deployment lands picks up the new shell on the next
      // navigation (and via the PwaUpdate effect on the current page).
      // The sc.handle_command version gate is the safety net: a bundle that
      // somehow stays running after the floor is raised is refused at the
      // authoritative layer with VERSION_STALE, and the UI locks on the
      // update screen until the fresh shell takes over.
      registerType: 'autoUpdate',
      includeAssets: ['pwa/icon-192.png', 'pwa/icon-512.png'],
      manifest: {
        name: 'SCREAM CONTROL — Room 305',
        short_name: 'Scream 305',
        description: 'Điều phối sự kiện Halloween cho năm trực máy.',
        id: '/',
        start_url: '/',
        scope: '/',
        display: 'standalone',
        orientation: 'portrait',
        background_color: '#0a0a0c',
        theme_color: '#0a0a0c',
        icons: [
          { src: '/pwa/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
          { src: '/pwa/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
          { src: '/pwa/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      workbox: {
        // The operational dashboard must never be served from a stale cache while
        // an event is live: the app shell caches, API responses always hit source.
        globPatterns: ['**/*.{js,css,html,svg,png,woff2}'],
        navigateFallbackDenylist: [/^\/api\//],
        cleanupOutdatedCaches: true,
        clientsClaim: true,
        skipWaiting: true,
      },
    }),
  ],
  server: { host: true, port: 5173, strictPort: false },
  preview: { host: true, port: 4173 },
  build: { target: 'es2022', sourcemap: true },
});
