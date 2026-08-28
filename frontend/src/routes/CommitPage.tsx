import { useMemo, useState } from "react";
import { ConnectButton } from "@rainbow-me/rainbowkit";
import { parseEventLogs, type Hex } from "viem";
import { useAccount, usePublicClient, useWriteContract } from "wagmi";

import { callRegistryAbi } from "../contracts/abis";
import { CHAIN, REGISTRY_ADDRESS, explorerTx, isDeployed } from "../contracts/addresses";
import { Callout, ExplorerLink, Field, Spinner } from "../components/ui";
import { ASSETS } from "../lib/assets";
import { errorMessage } from "../lib/errors";
import {
  Direction,
  formatStake,
  formatWindow,
  fromDateTimeLocal,
  nowSeconds,
  parsePrice,
  parseStake,
  toDateTimeLocal,
} from "../lib/format";
import {
  attachCallId,
  downloadSecrets,
  generateSalt,
  saveSecret,
  type CallSecret,
} from "../lib/salt";
import { useProtocolParams, useSupportedAssets } from "../hooks/useProtocol";

/**
 * The commit screen.
 *
 * Two things here are not negotiable and are worth stating where somebody
 * editing this file will read them:
 *
 *   1. **The salt comes from `crypto.getRandomValues`.** A predictable salt
 *      makes the commitment decorative — the space of plausible predictions is
 *      small enough to enumerate, and the salt is the only thing that stops an
 *      attacker confirming a guess.
 *
 *   2. **The commitment is computed by the contract**, through the `pure`
 *      `computeCommitment`, and never by re-implementing `abi.encode` here. A
 *      divergence between the two encodings does not throw and does not fail a
 *      test — it produces a commitment that cannot be opened, and the first
 *      symptom is a forfeited stake weeks later.
 *
 * The salt is written to the vault *before* the transaction is signed. Signing
 * first and storing after leaves a window in which a closed tab loses the salt
 * for a call that is already on-chain and already holding money.
 */

type Phase =
  | { kind: "idle" }
  | { kind: "working"; note: string }
  | { kind: "done"; callId: bigint; txHash: Hex; secret: CallSecret };

export default function CommitPage() {
  const { address, isConnected } = useAccount();
  const publicClient = usePublicClient({ chainId: CHAIN.id });
  const { writeContractAsync } = useWriteContract();

  const { params } = useProtocolParams();
  const { supported, isLoading: loadingAssets } = useSupportedAssets();

  const [assetId, setAssetId] = useState<Hex>(ASSETS[0]?.id ?? ("0x" as Hex));
  const [direction, setDirection] = useState<Direction>(Direction.Above);
  const [target, setTarget] = useState("");
  const [stake, setStake] = useState("0.001");
  const [deadlineInput, setDeadlineInput] = useState(() =>
    toDateTimeLocal(nowSeconds() + 24 * 3600),
  );

  const [phase, setPhase] = useState<Phase>({ kind: "idle" });
  const [error, setError] = useState<string>();

  const bounds = useMemo(() => {
    if (!params) return undefined;
    const now = nowSeconds();
    return {
      earliest: now + Number(params.minHorizon),
      latest: now + Number(params.maxHorizon),
    };
  }, [params]);

  const validation = useMemo(() => {
    const problems: Record<string, string> = {};

    try {
      parsePrice(target);
    } catch (issue) {
      if (target !== "") problems.target = (issue as Error).message;
    }

    try {
      const wei = parseStake(stake);
      if (params && wei < params.minStake) {
        problems.stake = `The protocol minimum is ${formatStake(params.minStake)}.`;
      }
    } catch (issue) {
      problems.stake = (issue as Error).message;
    }

    try {
      const deadline = fromDateTimeLocal(deadlineInput);
      if (bounds && deadline < bounds.earliest) {
        problems.deadline = `Too soon. The earliest allowed deadline is ${new Date(bounds.earliest * 1000).toLocaleString()}.`;
      }
      if (bounds && deadline > bounds.latest) {
        problems.deadline = `Too far out. The latest allowed deadline is ${new Date(bounds.latest * 1000).toLocaleString()}.`;
      }
    } catch (issue) {
      problems.deadline = (issue as Error).message;
    }

    if (!loadingAssets && !supported.has(assetId)) {
      problems.asset =
        "This deployment has no price feed for that asset. A call against it could never be revealed.";
    }

    return problems;
  }, [target, stake, deadlineInput, params, bounds, supported, assetId, loadingAssets]);

  const ready =
    isConnected &&
    isDeployed &&
    Boolean(params) &&
    !params?.paused &&
    target !== "" &&
    Object.keys(validation).length === 0 &&
    phase.kind !== "working";

  async function onCommit() {
    if (!publicClient || !address || !params) return;
    setError(undefined);

    try {
      const targetPrice = parsePrice(target);
      const deadline = BigInt(fromDateTimeLocal(deadlineInput));
      const value = parseStake(stake);

      setPhase({ kind: "working", note: "Generating a salt and hashing through the contract…" });
      const salt = generateSalt();

      // The contract's own `pure` function. Not a local keccak256 — see the
      // note at the top of this file.
      const commitment = await publicClient.readContract({
        address: REGISTRY_ADDRESS,
        abi: callRegistryAbi,
        functionName: "computeCommitment",
        args: [assetId, direction, targetPrice, deadline, salt, address],
      });

      const secret: CallSecret = {
        version: 1,
        chainId: CHAIN.id,
        registry: REGISTRY_ADDRESS,
        analyst: address,
        commitment,
        assetId,
        direction,
        targetPrice: targetPrice.toString(),
        deadline: Number(deadline),
        salt,
      };

      // Before signing. Always.
      saveSecret(secret);

      setPhase({ kind: "working", note: "Waiting for the signature…" });
      const txHash = await writeContractAsync({
        address: REGISTRY_ADDRESS,
        abi: callRegistryAbi,
        functionName: "commitCall",
        args: [commitment, deadline],
        value,
      });

      setPhase({ kind: "working", note: "Waiting for the transaction to be mined…" });
      const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });

      const events = parseEventLogs({
        abi: callRegistryAbi,
        eventName: "CallCommitted",
        logs: receipt.logs,
      });
      const event = events[0];
      if (!event) throw new Error("The transaction was mined but carried no CallCommitted event.");

      attachCallId(commitment, REGISTRY_ADDRESS, {
        callId: event.args.callId.toString(),
        committedAt: Number(event.args.committedAt),
        txHash,
      });

      setPhase({
        kind: "done",
        callId: event.args.callId,
        txHash,
        secret: { ...secret, callId: event.args.callId.toString(), txHash },
      });
      setTarget("");
    } catch (issue) {
      setError(errorMessage(issue));
      setPhase({ kind: "idle" });
    }
  }

  if (!isConnected) {
    return (
      <>
        <Header />
        <div className="card">
          <p>Connect a wallet to commit a call.</p>
          <ConnectButton />
        </div>
      </>
    );
  }

  if (phase.kind === "done") {
    return (
      <>
        <Header />
        <SuccessCard
          callId={phase.callId}
          txHash={phase.txHash}
          secret={phase.secret}
          onAnother={() => setPhase({ kind: "idle" })}
        />
      </>
    );
  }

  return (
    <>
      <Header />

      {params?.paused ? (
        <Callout tone="warn" title="New commits are paused">
          <p>Open calls are unaffected. Reveals and forfeits never pause — that is deliberate.</p>
        </Callout>
      ) : null}

      <div className="card">
        <div className="stack">
          <div className="grid-2">
            <Field
              label="Asset"
              error={validation.asset}
              hint="Only assets with a price feed on this deployment can ever be revealed."
            >
              <select value={assetId} onChange={(event) => setAssetId(event.target.value as Hex)}>
                {ASSETS.map((asset) => (
                  <option key={asset.id} value={asset.id}>
                    {asset.symbol} — {asset.label}
                  </option>
                ))}
              </select>
            </Field>

            <Field label="Claim" hint="Equality counts as a win for both directions.">
              <div className="segmented">
                <button
                  type="button"
                  aria-pressed={direction === Direction.Above}
                  onClick={() => setDirection(Direction.Above)}
                >
                  At or above
                </button>
                <button
                  type="button"
                  aria-pressed={direction === Direction.Below}
                  onClick={() => setDirection(Direction.Below)}
                >
                  At or below
                </button>
              </div>
            </Field>
          </div>

          <div className="grid-2">
            <Field
              label="Target price (USD)"
              error={validation.target}
              hint="Held to 8 decimals, the precision every feed is normalized to."
            >
              <input
                className="mono"
                inputMode="decimal"
                placeholder="3000.00"
                value={target}
                onChange={(event) => setTarget(event.target.value)}
              />
            </Field>

            <Field
              label="Stake (ETH)"
              error={validation.stake}
              hint={
                params
                  ? `Minimum ${formatStake(params.minStake)}. Lost on a wrong or unrevealed call.`
                  : undefined
              }
            >
              <input
                className="mono"
                inputMode="decimal"
                value={stake}
                onChange={(event) => setStake(event.target.value)}
              />
            </Field>
          </div>

          <Field
            label="Deadline"
            error={validation.deadline}
            hint={
              params
                ? `Between ${formatWindow(params.minHorizon)} and ${formatWindow(params.maxHorizon)} from now. The price at this exact moment decides the outcome.`
                : undefined
            }
          >
            <input
              type="datetime-local"
              className="mono"
              value={deadlineInput}
              onChange={(event) => setDeadlineInput(event.target.value)}
            />
          </Field>

          <Callout tone="warn" title="The salt is the whole thing">
            <p>
              Committing generates a 256-bit salt and stores it in this browser. It is the only
              copy. Lose it — cleared site data, a different machine, a private window — and the
              call can never be opened, the window closes, and the stake goes to the treasury.
              Download the backup on the next screen.
            </p>
          </Callout>

          {error ? (
            <Callout tone="danger" title="That did not go through">
              <p>{error}</p>
            </Callout>
          ) : null}

          <div className="row">
            <button className="primary" disabled={!ready} onClick={onCommit}>
              {phase.kind === "working" ? <Spinner /> : null} Commit the call
            </button>
            {phase.kind === "working" ? <span className="hint">{phase.note}</span> : null}
            {params ? (
              <span className="hint">
                Reveal window once the deadline passes: {formatWindow(params.revealWindow)}.
              </span>
            ) : null}
          </div>
        </div>
      </div>
    </>
  );
}

function Header() {
  return (
    <div className="page-header">
      <h1>Commit a call</h1>
      <p>
        The prediction is hashed with a random salt and your address, so it is timestamped on-chain
        and unreadable until you open it. Nothing about it can be changed afterwards.
      </p>
    </div>
  );
}

function SuccessCard({
  callId,
  txHash,
  secret,
  onAnother,
}: {
  callId: bigint;
  txHash: Hex;
  secret: CallSecret;
  onAnother: () => void;
}) {
  const [downloaded, setDownloaded] = useState(false);

  return (
    <div className="card">
      <div className="card-title">
        <h2>Call #{callId.toString()} is on-chain</h2>
        <ExplorerLink href={explorerTx(txHash)}>View transaction</ExplorerLink>
      </div>

      <Callout tone="danger" title="Back up the salt now">
        <p>
          The salt for this call exists in one place: this browser profile. There is no recovery —
          not by you, not by an admin, not by the chain. Download it and put it somewhere that is
          not a browser.
        </p>
        <div className="row" style={{ marginTop: "0.75rem" }}>
          <button
            className="primary"
            onClick={() => {
              downloadSecrets([secret], `proof-of-call-${callId.toString()}.json`);
              setDownloaded(true);
            }}
          >
            Download the salt
          </button>
          {downloaded ? <span className="hint">Saved. Keep it with your other keys.</span> : null}
        </div>
      </Callout>

      <hr className="divider" />

      <dl className="kv">
        <dt>Commitment</dt>
        <dd>{secret.commitment}</dd>
        <dt>Salt</dt>
        <dd>{secret.salt}</dd>
        <dt>Deadline</dt>
        <dd>{new Date(secret.deadline * 1000).toLocaleString()}</dd>
      </dl>

      <div className="row" style={{ marginTop: "1rem" }}>
        <button onClick={onAnother}>Commit another</button>
      </div>
    </div>
  );
}
