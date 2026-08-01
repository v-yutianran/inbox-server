/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_INBOX_API_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
