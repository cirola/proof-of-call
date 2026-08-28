import { useAccount } from "wagmi";

import { explorerAddress, isDeployed } from "../contracts/addresses";
import { Callout, Empty, ExplorerLink, Spinner } from "../components/ui";
import { EDGE_REFERENCE, FORFEIT_PENALTY, MAX_WEIGHT } from "../lib/boldness";
import { formatStake, shortAddress } from "../lib/format";
import { useCalls } from "../hooks/useCalls";
import { buildLeaderboard, useSpotAtCommit } from "../hooks/useLeaderboard";

/**
 * The leaderboard, with the line between chain data and opinion drawn on the
 * page rather than left to the reader.
 *
 * The counts are chain data. The score is not: it needs the spot price at commit
 * time, which nothing on-chain records — `commitCall` cannot know the asset,
 * because the asset is the thing being hidden (ADR-004). This page fetches that
 * price itself, weights each call by how far the target was from it, and says so
 * in the methodology block at the bottom.
 *
 * Presenting the weighted number as though the protocol computed it would be the
 * one dishonest thing in an application whose entire premise is an auditable
 * record.
 */
export default function LeaderboardPage() {
  const { address } = useAccount();
  const { data, isLoading } = useCalls();
  const spots = useSpotAtCommit(data);

  const rows = buildLeaderboard(data, spots.data);

  if (!isDeployed) return <Empty>No contract addresses are configured in this build.</Empty>;

  return (
    <>
      <div className="page-header">
        <h1>Leaderboard</h1>
        <p>
          Committed, won, lost and forfeited are counted by the contract and cannot be edited by
          anyone, including whoever is running this site. The score is this frontend's opinion about
          how bold each call was.
        </p>
      </div>

      {isLoading ? (
        <Empty>
          <Spinner /> Reading the registry…
        </Empty>
      ) : rows.length === 0 ? (
        <Empty>Nobody has committed a call yet.</Empty>
      ) : (
        <div className="card">
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Analyst</th>
                  <th className="num">Score</th>
                  <th className="num">Committed</th>
                  <th className="num">Won</th>
                  <th className="num">Lost</th>
                  <th className="num">Forfeited</th>
                  <th className="num">Open</th>
                  <th className="num">Staked</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={row.analyst}>
                    <td>
                      <ExplorerLink href={explorerAddress(row.analyst)}>
                        {shortAddress(row.analyst)}
                      </ExplorerLink>
                      {address && row.analyst.toLowerCase() === address.toLowerCase() ? (
                        <span className="pill open" style={{ marginLeft: "0.5rem" }}>
                          you
                        </span>
                      ) : null}
                      {row.unweighted > 0 ? (
                        <div className="hint">{row.unweighted} call(s) could not be weighted</div>
                      ) : null}
                    </td>
                    <td className="num">{spots.isLoading ? <Spinner /> : row.score.toFixed(2)}</td>
                    <td className="num">{row.committed}</td>
                    <td className="num">{row.wins}</td>
                    <td className="num">{row.losses}</td>
                    <td className="num">{row.forfeited}</td>
                    <td className="num">{row.open}</td>
                    <td className="num">{formatStake(row.staked)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      <hr className="divider" />

      <Callout tone="info" title="How the score is computed, and why it is not on-chain">
        <p>
          A raw win count is gameable. &ldquo;ETH at or above $1&rdquo; resolves correct every time,
          and the contract has no way to notice: <code>commitCall</code> receives a hash, so it does
          not know the asset and cannot read a spot price. That opacity is the mechanism, not a gap
          in it.
        </p>
        <p>So the weighting happens here, off-chain, and it is a claim rather than a fact:</p>
        <pre className="flow">
          {`edge    = |target − spot at commit| / spot at commit
weight  = min(edge / ${EDGE_REFERENCE}, ${MAX_WEIGHT})        a ${EDGE_REFERENCE * 100}% call is worth 1.00
score  += +weight on a win, −weight on a loss
score  −= ${FORFEIT_PENALTY.toFixed(2)} per forfeit          no target was ever disclosed`}
        </pre>
        <p>
          The spot price at commit time is fetched from the same Chainlink feed the call settles
          against, by binary search over its history. A call whose spot price cannot be recovered is
          counted but left unweighted rather than guessed at.
        </p>
        <p>
          The forfeit penalty is flat because a forfeited call never disclosed a target. It is set
          at the reference weight on purpose — staying silent should cost roughly what an ordinary
          losing call costs, or silence becomes the cheap exit from a bad prediction, which is the
          exact behaviour the protocol exists to price.
        </p>
      </Callout>
    </>
  );
}
