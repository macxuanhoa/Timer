/// <reference types="vite/client" />
/// <reference types="vite-plugin-pwa/client" />

interface ImportMetaEnv {
  readonly VITE_BACKEND?: 'local' | 'supabase';
  readonly VITE_SUPABASE_URL?: string;
  readonly VITE_SUPABASE_ANON_KEY?: string;
  /** Self-hosted engine only: passcode used by the `?station=` dev links. */
  readonly VITE_DEV_PASSCODE?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
