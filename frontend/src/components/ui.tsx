import type { ReactNode } from "react";
import { STATUS_LABEL, Status } from "../lib/format";

/**
 * The small shared pieces. Everything here is presentational — no hooks, no
 * contract calls — so a page can be read top to bottom without following a
 * component into a network request.
 */

/**
 * A link to a block explorer, degrading to plain text when there is none.
 *
 * The local demo node has no explorer. Rendering an Etherscan link for an
 * address that only exists on one laptop is worse than rendering nothing: it
 * looks live and lands on a "not found" page. `explorerTx` and `explorerAddress`
 * return `undefined` there, and this swallows the anchor.
 */
export function ExplorerLink({
  href,
  children,
}: {
  href: string | undefined;
  children: ReactNode;
}) {
  if (!href) return <>{children}</>;
  return (
    <a href={href} target="_blank" rel="noreferrer">
      {children}
    </a>
  );
}

export function Callout({
  tone = "info",
  title,
  children,
}: {
  tone?: "info" | "warn" | "danger" | "good";
  title?: string;
  children: ReactNode;
}) {
  return (
    <div className={`callout ${tone}`} role={tone === "danger" ? "alert" : undefined}>
      {title ? <strong>{title}</strong> : null}
      {children}
    </div>
  );
}

export function Field({
  label,
  hint,
  error,
  children,
}: {
  label: string;
  hint?: ReactNode;
  error?: string | undefined;
  children: ReactNode;
}) {
  return (
    <div className="field">
      <label>{label}</label>
      {children}
      {error ? (
        <span className="field-error">{error}</span>
      ) : hint ? (
        <span className="field-hint">{hint}</span>
      ) : null}
    </div>
  );
}

const STATUS_CLASS: Record<Status, string> = {
  [Status.None]: "",
  [Status.Committed]: "open",
  [Status.RevealedWin]: "win",
  [Status.RevealedLoss]: "loss",
  [Status.Forfeited]: "forfeit",
};

export function StatusPill({ status }: { status: Status }) {
  return <span className={`pill ${STATUS_CLASS[status]}`}>{STATUS_LABEL[status]}</span>;
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="empty">{children}</div>;
}

export function Spinner() {
  return <span className="spinner" aria-hidden="true" />;
}

export function Stat({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="stat">
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}
