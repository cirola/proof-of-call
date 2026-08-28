import { getDefaultConfig } from "@rainbow-me/rainbowkit";
import { createConfig, http } from "wagmi";
import { injected } from "wagmi/connectors";
import { CHAIN, RPC_URL } from "./contracts/addresses";

/**
 * Wallet and transport configuration.
 *
 * wagmi is pinned to the 2.x line rather than tracking 3.x, because RainbowKit
 * 2's peer range does not include wagmi 3 and a mismatched pair fails at runtime
 * inside the connector rather than at install time (ADR-001).
 *
 * WalletConnect needs a project id from a hosted service, and RainbowKit's
 * `getDefaultConfig` throws on startup without one — a blank screen, not a
 * degraded connect modal. So a build with no id skips RainbowKit's wallet list
 * entirely and configures wagmi's plain injected connector: MetaMask and Rabby
 * keep working, QR-code and mobile wallets do not, and the difference is a
 * shorter modal rather than a broken page.
 */

const projectId = import.meta.env.VITE_WALLETCONNECT_PROJECT_ID?.trim();

const transports = {
  [CHAIN.id]: http(RPC_URL),
};

/** False when this build can only reach injected wallets. Surfaced in the UI. */
export const hasWalletConnect = Boolean(projectId);

export const wagmiConfig = projectId
  ? getDefaultConfig({
      appName: "Proof of Call",
      projectId,
      chains: [CHAIN],
      transports,
      ssr: false,
    })
  : createConfig({
      chains: [CHAIN],
      transports,
      connectors: [injected()],
    });
