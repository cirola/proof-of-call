import React from "react";
import ReactDOM from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { RainbowKitProvider, darkTheme } from "@rainbow-me/rainbowkit";
import { WagmiProvider } from "wagmi";

import App from "./App";
import { wagmiConfig } from "./wagmi";

import "@rainbow-me/rainbowkit/styles.css";
import "./styles.css";

/**
 * Provider order is fixed by the libraries: wagmi needs a query client, and
 * RainbowKit needs wagmi. Everything below reads chain state through those two.
 */
const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // A chain read that failed is usually a rate limit rather than a bug, and
      // one retry costs less than a page of error states.
      retry: 1,
      refetchOnWindowFocus: false,
    },
  },
});

const container = document.getElementById("root");
if (!container) throw new Error("No #root element in index.html.");

ReactDOM.createRoot(container).render(
  <React.StrictMode>
    <WagmiProvider config={wagmiConfig}>
      <QueryClientProvider client={queryClient}>
        <RainbowKitProvider theme={darkTheme({ accentColor: "#6ea8fe", borderRadius: "small" })}>
          <BrowserRouter>
            <App />
          </BrowserRouter>
        </RainbowKitProvider>
      </QueryClientProvider>
    </WagmiProvider>
  </React.StrictMode>,
);
