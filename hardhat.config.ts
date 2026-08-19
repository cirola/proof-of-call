import { configVariable, defineConfig } from "hardhat/config";
import hardhatToolboxViem from "@nomicfoundation/hardhat-toolbox-viem";

export default defineConfig({
  plugins: [hardhatToolboxViem],

  solidity: {
    // Two profiles: `default` for fast local iteration (no optimizer, so stack
    // traces and coverage line-map stay accurate), `production` for anything we
    // actually deploy. Coverage runs against `default` on purpose — an optimized
    // build reorders code and makes line hit-counts lie.
    profiles: {
      default: {
        version: "0.8.28",
        settings: {
          evmVersion: "cancun",
        },
      },
      production: {
        version: "0.8.28",
        settings: {
          evmVersion: "cancun",
          optimizer: {
            enabled: true,
            // 200 favours deployment cost over per-call cost. This contract is
            // deployed once and called often, but the call paths are short, so
            // the trade-off barely moves. Revisit if commitCall gas matters.
            runs: 200,
          },
        },
      },
    },
  },

  networks: {
    hardhatMainnet: {
      type: "edr-simulated",
      chainType: "l1",
    },
    sepolia: {
      type: "http",
      chainType: "l1",
      // configVariable() resolves from the encrypted Hardhat keystore first,
      // then from env vars. The secret never lands in this file or in .env.
      url: configVariable("SEPOLIA_RPC_URL"),
      accounts: [configVariable("SEPOLIA_PRIVATE_KEY")],
    },
  },

  verify: {
    etherscan: {
      apiKey: configVariable("ETHERSCAN_API_KEY"),
    },
  },
});
