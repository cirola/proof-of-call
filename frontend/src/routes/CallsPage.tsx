import { useState } from "react";
import { Link } from "react-router-dom";
import { useAccount, usePublicClient, useWriteContract } from "wagmi";
import type { Hex } from "viem";

import { callRegistryAbi } from "../contracts/abis";
import {
  CHAIN,
  REGISTRY_ADDRESS,
  explorerAddress,
  explorerTx,
  isDeployed,
} from "../contracts/addresses";
import { Callout, Empty, ExplorerLink, Field, Spinner, StatusPill } from "../components/ui";
import { assetLabel } from "../lib/assets";
import { errorMessage } from "../lib/errors";
import {
  DIRECTION_LABEL,
  Direction,
  Status,
  formatDateTime,
  formatRelative,
  formatStake,
  formatUsd,
  nowSeconds,
  shortAddress,
} from "../lib/format";
import { findSettlementRound, type SettlementRound } from "../lib/roundSearch";
import { findSecretByCallId } from "../lib/salt";
import { callsOf, forfeitableCalls, useCalls, type ProtocolCall } from "../hooks/useCalls";

/**
 * Every call in the registry, and the two actions that close one.
 *
 * `forfeit` is deliberately offered to everybody, not only to the call's own
 * analyst. That is not a courtesy feature — it is what makes attack A cost
 * something. If only the analyst could record their own forfeit, a hundred-call
 * spray would leave the ninety-seven bad ones sitting in `Committed` forever and
 * the visible record would still read as flawless.
 */
export default function CallsPage() {
  const { address } = useAccount();
  const { data, isLoading, refetch } = useCalls();
  const now = nowSeconds();

  const mine = callsOf(data, address);
  const forfeitable = forfeitableCalls(data, now);

  if (!isDeployed) {
    return <Empty>No contract addresses are configured in this build.</Empty>;
  }

  return (
    <>
      <div className="page-header">
        <h1>Calls</h1>
        <p>
          The whole registry, including the calls nobody opened. A call that misses its reveal
          window can be closed by anyone — its stake goes to the treasury and the forfeit is counted
          in the analyst's record.
        </p>
      </div>

      {data && !data.logsAvailable ? (
        <Callout tone="warn" title="The RPC endpoint would not serve event logs">
          <p>
            Statuses and stakes below are read from contract state and are correct. The revealed
            parameters — asset, target, settlement price — live only in events, so they are missing.
            Set <code>VITE_SEPOLIA_RPC_URL</code> to an endpoint that answers{" "}
            <code>eth_getLogs</code>.
          </p>
        </Callout>
      ) : null}

      {address ? (
        <section>
          <div className="card-title">
            <h2>Your calls</h2>
            <button className="small ghost" onClick={() => void refetch()}>
              Refresh
            </button>
          </div>
          {isLoading ? (
            <Empty>
              <Spinner /> Reading the registry…
            </Empty>
          ) : mine.length === 0 ? (
            <Empty>You have not committed anything yet.</Empty>
          ) : (
            <div className="stack">
              {mine.map((call) => (
                <OwnCallCard
                  key={call.id.toString()}
                  call={call}
                  now={now}
                  onSettled={() => void refetch()}
                />
              ))}
            </div>
          )}
        </section>
      ) : (
        <Empty>Connect a wallet to see and reveal your own calls.</Empty>
      )}

      <hr className="divider" />

      <section>
        <h2>Open past their window</h2>
        <p className="hint">
          Anyone can close these. The stake goes to the treasury and the forfeit lands in the
          analyst's public record.
        </p>
        {forfeitable.length === 0 ? (
          <Empty>Nothing is overdue.</Empty>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Call</th>
                  <th>Analyst</th>
                  <th>Window closed</th>
                  <th className="num">Stake</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {forfeitable.map((call) => (
                  <ForfeitRow
                    key={call.id.toString()}
                    call={call}
                    onSettled={() => void refetch()}
                  />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <hr className="divider" />

      <section>
        <h2>Everything</h2>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Call</th>
                <th>Analyst</th>
                <th>Status</th>
                <th>Prediction</th>
                <th>Deadline</th>
                <th className="num">Stake</th>
              </tr>
            </thead>
            <tbody>
              {(data?.calls ?? [])
                .slice()
                .reverse()
                .map((call) => (
                  <tr key={call.id.toString()}>
                    <td className="mono">#{call.id.toString()}</td>
                    <td>
                      <ExplorerLink href={explorerAddress(call.analyst)}>
                        {shortAddress(call.analyst)}
                      </ExplorerLink>
                    </td>
                    <td>
                      <StatusPill status={call.status} />
                    </td>
                    <td>{describePrediction(call)}</td>
                    <td>{formatDateTime(call.deadline)}</td>
                    <td className="num">{formatStake(call.stake)}</td>
                  </tr>
                ))}
            </tbody>
          </table>
        </div>
        {data && data.calls.length === 0 ? <Empty>The registry is empty.</Empty> : null}
      </section>
    </>
  );
}

function describePrediction(call: ProtocolCall) {
  if (!call.revealed) {
    return call.status === Status.Committed ? (
      <span className="hint">sealed</span>
    ) : (
      <span className="hint">never opened</span>
    );
  }
  const { assetId, direction, targetPrice, settlementPrice } = call.revealed;
  return (
    <span>
      {assetLabel(assetId)} {DIRECTION_LABEL[direction]}{" "}
      <span className="mono">{formatUsd(targetPrice)}</span>
      <br />
      <span className="hint">
        settled at <span className="mono">{formatUsd(settlementPrice)}</span>
      </span>
    </span>
  );
}

/* ------------------------------------------------------------------ */

function OwnCallCard({
  call,
  now,
  onSettled,
}: {
  call: ProtocolCall;
  now: number;
  onSettled: () => void;
}) {
  const open = call.status === Status.Committed;
  const beforeDeadline = now < Number(call.deadline);
  const windowClosed = now > Number(call.revealDeadline);

  return (
    <div className="card">
      <div className="card-title">
        <h3>
          Call #{call.id.toString()} <StatusPill status={call.status} />
        </h3>
        <span className="hint mono">{formatStake(call.stake)}</span>
      </div>

      <dl className="kv">
        <dt>Deadline</dt>
        <dd>
          {formatDateTime(call.deadline)}{" "}
          <span className="hint">({formatRelative(call.deadline)})</span>
        </dd>
        <dt>Reveal window</dt>
        <dd>
          closes {formatDateTime(call.revealDeadline)}{" "}
          <span className="hint">({formatRelative(call.revealDeadline)})</span>
        </dd>
        {call.revealed ? (
          <>
            <dt>Prediction</dt>
            <dd>
              {assetLabel(call.revealed.assetId)} {DIRECTION_LABEL[call.revealed.direction]}{" "}
              {formatUsd(call.revealed.targetPrice)}
            </dd>
            <dt>Settled at</dt>
            <dd>{formatUsd(call.revealed.settlementPrice)}</dd>
          </>
        ) : null}
      </dl>

      {open ? (
        beforeDeadline ? (
          <p className="hint" style={{ marginTop: "1rem" }}>
            Sealed until the deadline. Revealing early is rejected by the contract — that is the
            mechanism.
          </p>
        ) : windowClosed ? (
          <Callout tone="danger" title="The window closed">
            <p>
              This call can no longer be revealed. It will be recorded as a forfeit and the stake is
              gone.
            </p>
          </Callout>
        ) : (
          <RevealPanel call={call} onSettled={onSettled} />
        )
      ) : null}
    </div>
  );
}

/* ------------------------------------------------------------------ */

type RevealState =
  | { kind: "idle" }
  | { kind: "searching"; probes: number }
  | { kind: "found"; round: SettlementRound }
  | { kind: "submitting" }
  | { kind: "done"; txHash: Hex };

/**
 * The reveal.
 *
 * The awkward part is the round id. `getPriceAt` settles against the last
 * Chainlink round at or before the deadline and verifies the id it is given, and
 * Chainlink publishes no timestamp-to-round index — so the id has to be found
 * off-chain by binary search before the transaction can even be built. The
 * search is exposed as an explicit step rather than hidden inside the submit
 * handler, because it makes a dozen RPC calls and can legitimately fail.
 *
 * The manual override is for the one case the search cannot handle: a deadline
 * that predates the current aggregator phase (ADR-010's residual gap).
 */
function RevealPanel({ call, onSettled }: { call: ProtocolCall; onSettled: () => void }) {
  const publicClient = usePublicClient({ chainId: CHAIN.id });
  const { writeContractAsync } = useWriteContract();

  const secret = findSecretByCallId(CHAIN.id, REGISTRY_ADDRESS, call.id);
  const [state, setState] = useState<RevealState>({ kind: "idle" });
  const [error, setError] = useState<string>();
  const [manualRound, setManualRound] = useState("");

  if (!secret) {
    return (
      <Callout tone="danger" title="No salt for this call in this browser">
        <p>
          The prediction cannot be reconstructed without it. If you backed it up, import the file on
          the <Link to="/vault">Vault</Link> page. If you did not, the call cannot be opened and the
          stake is lost when the window closes — this is the failure mode the warning on the commit
          screen is about.
        </p>
      </Callout>
    );
  }

  async function search() {
    if (!publicClient || !secret) return;
    setError(undefined);
    setState({ kind: "searching", probes: 0 });
    try {
      const { round } = await findSettlementRound(publicClient, {
        resolver: (await resolverAddress(publicClient)) as `0x${string}`,
        assetId: secret.assetId,
        deadline: call.deadline,
        onProgress: ({ probes }) => setState({ kind: "searching", probes }),
      });
      setManualRound(round.roundId.toString());
      setState({ kind: "found", round });
    } catch (issue) {
      setError(errorMessage(issue));
      setState({ kind: "idle" });
    }
  }

  async function submit(roundId: bigint) {
    if (!publicClient || !secret) return;
    setError(undefined);
    setState({ kind: "submitting" });
    try {
      const txHash = await writeContractAsync({
        address: REGISTRY_ADDRESS,
        abi: callRegistryAbi,
        functionName: "revealCall",
        args: [
          call.id,
          {
            assetId: secret.assetId,
            direction: secret.direction as Direction,
            targetPrice: BigInt(secret.targetPrice),
            salt: secret.salt,
            roundId,
          },
        ],
      });
      await publicClient.waitForTransactionReceipt({ hash: txHash });
      setState({ kind: "done", txHash });
      onSettled();
    } catch (issue) {
      setError(errorMessage(issue));
      setState({ kind: "idle" });
    }
  }

  if (state.kind === "done") {
    return (
      <Callout tone="good" title="Revealed">
        <p>
          The contract re-hashed the parameters, read the feed at the deadline, and recorded the
          outcome. <ExplorerLink href={explorerTx(state.txHash)}>View transaction</ExplorerLink>.
        </p>
      </Callout>
    );
  }

  return (
    <div className="stack" style={{ marginTop: "1rem" }}>
      <dl className="kv">
        <dt>Asset</dt>
        <dd>{assetLabel(secret.assetId)}</dd>
        <dt>Claim</dt>
        <dd>
          {DIRECTION_LABEL[secret.direction as Direction]} {formatUsd(BigInt(secret.targetPrice))}
        </dd>
      </dl>

      {state.kind === "found" ? (
        <Callout tone="info" title="Settlement round found">
          <dl className="kv">
            <dt>Round id</dt>
            <dd>{state.round.roundId.toString()}</dd>
            <dt>Published</dt>
            <dd>
              {formatDateTime(state.round.updatedAt)}{" "}
              <span className="hint">({state.round.ageAtDeadline}s before the deadline)</span>
            </dd>
          </dl>
        </Callout>
      ) : null}

      {error ? (
        <Callout tone="danger" title="That did not go through">
          <p>{error}</p>
        </Callout>
      ) : null}

      <div className="row">
        <button
          onClick={() => void search()}
          disabled={state.kind === "searching" || state.kind === "submitting"}
        >
          {state.kind === "searching" ? <Spinner /> : null} Find the settlement round
        </button>
        {state.kind === "searching" ? (
          <span className="hint">probed {state.probes} rounds…</span>
        ) : null}

        <button
          className="primary"
          disabled={manualRound === "" || state.kind === "submitting" || state.kind === "searching"}
          onClick={() => void submit(BigInt(manualRound))}
        >
          {state.kind === "submitting" ? <Spinner /> : null} Reveal
        </button>
      </div>

      <details>
        <summary className="hint">Round id, if the search cannot find it</summary>
        <div style={{ marginTop: "0.75rem" }}>
          <Field
            label="Chainlink round id"
            hint="The search stays inside the feed's current aggregator phase. A deadline older than that phase needs the id entered by hand — ADR-010."
          >
            <input
              className="mono"
              value={manualRound}
              onChange={(event) => setManualRound(event.target.value)}
            />
          </Field>
        </div>
      </details>
    </div>
  );
}

/** The resolver the registry is currently pointed at, which is admin-settable. */
async function resolverAddress(client: NonNullable<ReturnType<typeof usePublicClient>>) {
  return client.readContract({
    address: REGISTRY_ADDRESS,
    abi: callRegistryAbi,
    functionName: "resolver",
  });
}

/* ------------------------------------------------------------------ */

function ForfeitRow({ call, onSettled }: { call: ProtocolCall; onSettled: () => void }) {
  const publicClient = usePublicClient({ chainId: CHAIN.id });
  const { writeContractAsync } = useWriteContract();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  async function forfeit() {
    if (!publicClient) return;
    setBusy(true);
    setError(undefined);
    try {
      const txHash = await writeContractAsync({
        address: REGISTRY_ADDRESS,
        abi: callRegistryAbi,
        functionName: "forfeit",
        args: [call.id],
      });
      await publicClient.waitForTransactionReceipt({ hash: txHash });
      onSettled();
    } catch (issue) {
      setError(errorMessage(issue));
    } finally {
      setBusy(false);
    }
  }

  return (
    <tr>
      <td className="mono">#{call.id.toString()}</td>
      <td>
        <ExplorerLink href={explorerAddress(call.analyst)}>
          {shortAddress(call.analyst)}
        </ExplorerLink>
      </td>
      <td>
        {formatDateTime(call.revealDeadline)}{" "}
        <span className="hint">({formatRelative(call.revealDeadline)})</span>
        {error ? <div className="field-error">{error}</div> : null}
      </td>
      <td className="num">{formatStake(call.stake)}</td>
      <td>
        <button className="small" disabled={busy} onClick={() => void forfeit()}>
          {busy ? <Spinner /> : null} Forfeit
        </button>
      </td>
    </tr>
  );
}
