import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  build: {
    // WalletConnect and RainbowKit are large. Splitting them out of the entry
    // chunk means the commit form paints before the wallet stack has parsed.
    rollupOptions: {
      output: {
        manualChunks: {
          wallet: ["@rainbow-me/rainbowkit", "wagmi", "viem"],
        },
      },
    },
  },
});
