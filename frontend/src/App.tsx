import { ConnectButton } from "@rainbow-me/rainbowkit";
import { NavLink, Navigate, Route, Routes } from "react-router-dom";
import { useAccount, useChainId } from "wagmi";

import {
  CHAIN,
  REGISTRY_ADDRESS,
  explorerAddress,
  isDeployed,
  isLocalChain,
} from "./contracts/addresses";
import { Callout, ExplorerLink } from "./components/ui";
import { shortAddress } from "./lib/format";
import { hasWalletConnect } from "./wagmi";
import CommitPage from "./routes/CommitPage";
import CallsPage from "./routes/CallsPage";
import LeaderboardPage from "./routes/LeaderboardPage";
import VaultPage from "./routes/VaultPage";

/**
 * Shell and routing.
 *
 * Two banners live at this level because they invalidate every page below them:
 * a build with no contract addresses, and a wallet on the wrong chain. Both are
 * shown once here rather than re-checked in four places.
 */
export default function App() {
  const { isConnected } = useAccount();
  const chainId = useChainId();
  const wrongChain = isConnected && chainId !== CHAIN.id;

  return (
    <div className="app">
      <header className="masthead">
        <div className="masthead-inner">
          <NavLink to="/" className="wordmark">
            Proof of Call <span>/ {CHAIN.name}</span>
          </NavLink>
          <nav className="tabs">
            <NavLink to="/commit" className={({ isActive }) => (isActive ? "active" : "")}>
              Commit
            </NavLink>
            <NavLink to="/calls" className={({ isActive }) => (isActive ? "active" : "")}>
              Calls
            </NavLink>
            <NavLink to="/leaderboard" className={({ isActive }) => (isActive ? "active" : "")}>
              Leaderboard
            </NavLink>
            <NavLink to="/vault" className={({ isActive }) => (isActive ? "active" : "")}>
              Vault
            </NavLink>
          </nav>
          <ConnectButton showBalance={false} chainStatus="icon" />
        </div>
      </header>

      <main>
        <div className="stack">
          {!isDeployed ? (
            <Callout tone="danger" title="This build has no contract addresses">
              <p>
                Set <code>VITE_REGISTRY_ADDRESS</code> and <code>VITE_RESOLVER_ADDRESS</code> in{" "}
                <code>frontend/.env.local</code> to the addresses printed by{" "}
                <code>npm run demo</code> (local node) or <code>npm run deploy:sepolia</code>. Until
                then every page is read-only and empty.
              </p>
            </Callout>
          ) : null}

          {isLocalChain && isDeployed ? (
            <Callout tone="info" title="Local demo node">
              <p>
                This build talks to a Hardhat node on your machine, against mock Chainlink
                aggregators driven by <code>npm run demo</code>. Nothing here is on a public chain,
                the ETH is not real, and the state disappears when the node stops.
              </p>
            </Callout>
          ) : null}

          {wrongChain ? (
            <Callout tone="warn" title={`Switch to ${CHAIN.name}`}>
              <p>
                The protocol is deployed on {CHAIN.name} only. Transactions signed on another chain
                will not reach it.
              </p>
            </Callout>
          ) : null}

          <Routes>
            <Route path="/" element={<Navigate to="/commit" replace />} />
            <Route path="/commit" element={<CommitPage />} />
            <Route path="/calls" element={<CallsPage />} />
            <Route path="/leaderboard" element={<LeaderboardPage />} />
            <Route path="/vault" element={<VaultPage />} />
            <Route path="*" element={<Navigate to="/commit" replace />} />
          </Routes>
        </div>
      </main>

      <footer>
        <div className="footer-inner">
          <span>
            {hasWalletConnect
              ? null
              : "Injected wallets only — no WalletConnect project id in this build. "}
            Counts are chain data. The leaderboard ranking is a claim by this frontend — see{" "}
            <NavLink to="/leaderboard">how it is computed</NavLink>.
          </span>
          {isDeployed ? (
            <ExplorerLink href={explorerAddress(REGISTRY_ADDRESS)}>
              Registry {shortAddress(REGISTRY_ADDRESS)}
            </ExplorerLink>
          ) : null}
        </div>
      </footer>
    </div>
  );
}
