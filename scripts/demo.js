#!/usr/bin/env node
import { spawn } from "node:child_process";
import { createConnection } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * `npm run demo` — the whole thing, in one command.
 *
 * Starts a Hardhat node, deploys the protocol against mock Chainlink feeds,
 * keeps publishing rounds so the price moves, and serves the frontend already
 * pointed at what it just deployed. Ctrl-C stops all three.
 *
 * This exists because the alternative is three terminals in a fixed order, and
 * the second one has to wait for the first. Anyone reading this repository for
 * the first time should be able to see it work before deciding whether to read
 * further.
 */

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

const RPC_HOST = "127.0.0.1";
const RPC_PORT = 8545;

/** Every child, so a single Ctrl-C takes the whole tree down. */
const children = [];
let shuttingDown = false;

function run(name, command, args, options = {}) {
  const child = spawn(command, args, {
    cwd: ROOT,
    stdio: "inherit",
    // Windows resolves `npx`/`hardhat` through a `.cmd` shim, which is not an
    // executable spawn() can launch directly.
    shell: process.platform === "win32",
    ...options,
  });

  child.on("exit", (code, signal) => {
    if (shuttingDown) return;
    console.error(`\n[demo] ${name} exited (${signal ?? `code ${code}`}). Stopping the demo.`);
    shutdown(code ?? 1);
  });

  children.push({ name, child });
  return child;
}

function shutdown(code) {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const { child } of children) {
    if (child.exitCode === null && child.signalCode === null) child.kill();
  }
  // Give the children a moment to die on their own before the process leaves.
  setTimeout(() => process.exit(code), 300).unref();
}

/** Resolves once something is listening on the JSON-RPC port. */
function waitForRpc(timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;

  return new Promise((resolve, reject) => {
    const attempt = () => {
      const socket = createConnection({ host: RPC_HOST, port: RPC_PORT });
      socket.once("connect", () => {
        socket.destroy();
        resolve();
      });
      socket.once("error", () => {
        socket.destroy();
        if (Date.now() > deadline) {
          reject(new Error(`No JSON-RPC server on ${RPC_HOST}:${RPC_PORT} after ${timeoutMs}ms`));
          return;
        }
        setTimeout(attempt, 250);
      });
    };
    attempt();
  });
}

process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));

console.log("[demo] starting Hardhat node…");
run(
  "hardhat node",
  "npx",
  ["hardhat", "node", "--hostname", RPC_HOST, "--port", String(RPC_PORT)],
  // The node logs every JSON-RPC call it serves, which at one round every five
  // seconds buries the demo's own output. stderr still comes through, so a node
  // that fails to start is still visible.
  { stdio: ["inherit", "ignore", "inherit"] },
);

await waitForRpc().catch((error) => {
  console.error(`[demo] ${error.message}`);
  shutdown(1);
  throw error;
});

console.log("[demo] node is up. Deploying the protocol…");

// The deploy script does not exit: after deploying it becomes the price keeper.
// The frontend waits only for the file it writes, so a fixed delay here would be
// a race. Watch stdout instead — the deploy prints the env path when it is done.
const deploy = run("deploy", "npx", ["hardhat", "run", "scripts/demo-deploy.ts"], {
  stdio: ["inherit", "pipe", "inherit"],
});

let frontendStarted = false;
deploy.stdout.setEncoding("utf8");
deploy.stdout.on("data", (chunk) => {
  process.stdout.write(chunk);
  if (!frontendStarted && chunk.includes("wrote ")) {
    frontendStarted = true;
    console.log("[demo] contracts are live. Starting the frontend…\n");
    run("frontend", "npm", ["--prefix", "frontend", "run", "dev"]);
  }
});
