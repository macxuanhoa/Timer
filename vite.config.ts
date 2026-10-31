import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { VitePWA } from 'vite-plugin-pwa';
import { screamLocalServer } from './src/server/vitePlugin.ts';

const useSupabase = process.env.VITE_BACKEND === 'supabase';

export default defineConfig({
  plugins: [
    tailwindcss(),
    react(),
    // The authoritative engine runs in-process during development so the full
    // five-operator workflow is testable with zero external credentials.
    ...(useSupabase ? [] : [screamLocalServer({ dataFile: '.scream-data/event.json' })]),
    VitePWA({
      registerType: 'prompt',
      includeAssets: ['pwa/icon-192.png', 'pwa/icon-512.png'],
      manifest: {
        name: 'SCREAM CONTROL — Room 305',
        short_name: 'Scream 305',
        description: 'Điều phối sự kiện Halloween 90 phút cho năm trực máy.',
        id: '/',
        start_url: '/',
        scope: '/',
        display: 'standalone',
        orientation: 'portrait',
        background_color: '#121214',
        theme_color: '#121214',
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
        clientsClaim: false,
        skipWaiting: false,
      },
    }),
  ],
  server: { host: true, port: 5173, strictPort: false },
  preview: { host: true, port: 4173 },
  build: { target: 'es2022', sourcemap: true },
});
