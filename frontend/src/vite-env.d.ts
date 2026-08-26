/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_REGISTRY_ADDRESS?: string;
  readonly VITE_RESOLVER_ADDRESS?: string;
  readonly VITE_WALLETCONNECT_PROJECT_ID?: string;
  readonly VITE_SEPOLIA_RPC_URL?: string;
  readonly VITE_DEPLOY_BLOCK?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
