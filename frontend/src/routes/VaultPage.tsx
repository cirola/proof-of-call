import { useRef, useState } from "react";
import { useAccount } from "wagmi";

import { CHAIN, REGISTRY_ADDRESS } from "../contracts/addresses";
import { Callout, Empty } from "../components/ui";
import { assetLabel } from "../lib/assets";
import { DIRECTION_LABEL, Direction, formatDateTime, formatUsd, shortHash } from "../lib/format";
import {
  downloadSecrets,
  importSecrets,
  listAllSecrets,
  listSecrets,
  removeSecret,
  type CallSecret,
} from "../lib/salt";

/**
 * Salt custody, given a page of its own.
 *
 * This is the hard part of the UX and burying it in a settings menu would be a
 * design mistake with a price tag: a salt is a 256-bit secret worth exactly the
 * stake behind it, it exists only in this browser profile, and nothing anywhere
 * can regenerate it. Clearing site data is a total loss. So the export is one
 * click from the navigation bar, and the import is right beside it for the
 * machine where the salt is not.
 */
export default function VaultPage() {
  const { address } = useAccount();
  const [refreshKey, setRefreshKey] = useState(0);
  const [notice, setNotice] = useState<string>();
  const [error, setError] = useState<string>();
  const fileInput = useRef<HTMLInputElement>(null);

  const all = listAllSecrets();
  const mine = address ? listSecrets(CHAIN.id, REGISTRY_ADDRESS, address) : [];
  void refreshKey;

  async function onImport(file: File) {
    setError(undefined);
    setNotice(undefined);
    try {
      const { added, skipped } = importSecrets(await file.text());
      setNotice(
        `Imported ${added} new entr${added === 1 ? "y" : "ies"}; ${skipped} already present.`,
      );
      setRefreshKey((key) => key + 1);
    } catch (issue) {
      setError((issue as Error).message);
    }
  }

  return (
    <>
      <div className="page-header">
        <h1>Salt vault</h1>
        <p>
          Every commit stores its salt here, in this browser, under this origin. A salt plus the
          four public parameters is the only way to open a call — and the only copy of it is the one
          on this screen until you export it.
        </p>
      </div>

      <Callout tone="danger" title="There is no recovery">
        <p>
          Losing a salt is not an inconvenience. The commitment cannot be opened, the reveal window
          closes, the call is recorded as a forfeit, and the stake goes to the treasury. No admin
          key changes that; no part of the protocol has the salt to give back.
        </p>
      </Callout>

      <div className="card">
        <div className="card-title">
          <h2>Backup</h2>
          <span className="hint">
            {all.length} entr{all.length === 1 ? "y" : "ies"} stored
          </span>
        </div>
        <div className="row">
          <button
            className="primary"
            disabled={all.length === 0}
            onClick={() =>
              downloadSecrets(
                all,
                `proof-of-call-vault-${new Date().toISOString().slice(0, 10)}.json`,
              )
            }
          >
            Export everything
          </button>
          <button onClick={() => fileInput.current?.click()}>Import a backup</button>
          <input
            ref={fileInput}
            type="file"
            accept="application/json"
            style={{ display: "none" }}
            onChange={(event) => {
              const file = event.target.files?.[0];
              if (file) void onImport(file);
              event.target.value = "";
            }}
          />
        </div>
        <p className="hint">
          Importing merges rather than replaces, so restoring a backup on a machine that already has
          live calls does not delete them.
        </p>
        {notice ? (
          <div style={{ marginTop: "0.75rem" }}>
            <Callout tone="good">{notice}</Callout>
          </div>
        ) : null}
        {error ? (
          <div style={{ marginTop: "0.75rem" }}>
            <Callout tone="danger">{error}</Callout>
          </div>
        ) : null}
      </div>

      <div className="card">
        <div className="card-title">
          <h2>Your salts on {CHAIN.name}</h2>
        </div>
        {!address ? (
          <Empty>Connect a wallet to see the salts belonging to it.</Empty>
        ) : mine.length === 0 ? (
          <Empty>No salts stored for this account in this browser.</Empty>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Call</th>
                  <th>Prediction</th>
                  <th>Deadline</th>
                  <th>Commitment</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {mine.map((secret) => (
                  <VaultRow
                    key={secret.commitment}
                    secret={secret}
                    onDeleted={() => setRefreshKey((key) => key + 1)}
                  />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </>
  );
}

function VaultRow({ secret, onDeleted }: { secret: CallSecret; onDeleted: () => void }) {
  const [confirming, setConfirming] = useState(false);

  return (
    <tr>
      <td className="mono">{secret.callId ? `#${secret.callId}` : "—"}</td>
      <td>
        {assetLabel(secret.assetId)} {DIRECTION_LABEL[secret.direction as Direction]}{" "}
        <span className="mono">{formatUsd(BigInt(secret.targetPrice))}</span>
      </td>
      <td>{formatDateTime(secret.deadline)}</td>
      <td className="mono">{shortHash(secret.commitment)}</td>
      <td>
        <div className="row">
          <button
            className="small"
            onClick={() =>
              downloadSecrets([secret], `proof-of-call-${secret.callId ?? "pending"}.json`)
            }
          >
            Download
          </button>
          {confirming ? (
            <button
              className="small danger"
              onClick={() => {
                removeSecret(secret.commitment, secret.registry);
                onDeleted();
              }}
            >
              Delete for good
            </button>
          ) : (
            <button className="small ghost" onClick={() => setConfirming(true)}>
              Delete
            </button>
          )}
        </div>
      </td>
    </tr>
  );
}
